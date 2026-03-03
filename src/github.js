const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

function authHeaders(token) {
  const headers = {
    "User-Agent": "pretty-me-svg-service",
    Accept: "application/vnd.github+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub REST error ${response.status}: ${text}`);
  }
  return response.json();
}

async function fetchGraphql(query, variables, token) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for contribution totals.");
  }

  const response = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub GraphQL error ${response.status}: ${text}`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${result.errors.map((item) => item.message).join(" | ")}`);
  }

  return result.data;
}

function dateOnlyUtc(isoString) {
  return new Date(isoString).toISOString().slice(0, 10);
}

async function fetchPaginated(urlBuilder, token, stopWhen) {
  let page = 1;
  const allItems = [];

  while (true) {
    const items = await fetchJson(urlBuilder(page), token);
    if (!Array.isArray(items)) {
      throw new Error("Unexpected GitHub API response while paginating.");
    }

    for (const item of items) {
      if (stopWhen && stopWhen(item)) {
        return allItems;
      }
      allItems.push(item);
    }

    if (items.length < 100) {
      return allItems;
    }

    page += 1;
  }
}

async function getAuthenticatedLogin(token) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required when repo_visibility=all.");
  }

  const me = await fetchJson(`${GITHUB_API}/user`, token);
  return String(me.login || "");
}

export async function listOwnedRepos(username, token, repoVisibility) {
  if (repoVisibility === "all") {
    const login = await getAuthenticatedLogin(token);
    if (login.toLowerCase() !== username.toLowerCase()) {
      throw new Error("repo_visibility=all only works when :username matches the authenticated GITHUB_TOKEN user.");
    }

    const repos = await fetchPaginated(
      (page) => `${GITHUB_API}/user/repos?affiliation=owner&visibility=all&sort=updated&per_page=100&page=${page}`,
      token,
    );

    return repos.map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      defaultBranch: repo.default_branch,
      stars: repo.stargazers_count || 0,
    }));
  }

  const repos = await fetchPaginated(
    (page) =>
      `${GITHUB_API}/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    token,
  );

  return repos.map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch,
    stars: repo.stargazers_count || 0,
  }));
}

async function listContributedRepos(username, fromIso, toIso, token, repoVisibility) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required when repo_scope includes contributed repositories.");
  }

  const query = `
    query ContributedRepos($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              name
              nameWithOwner
              stargazerCount
              isPrivate
              owner { login }
              defaultBranchRef { name }
            }
          }
          pullRequestContributionsByRepository(maxRepositories: 100) {
            repository {
              name
              nameWithOwner
              stargazerCount
              isPrivate
              owner { login }
              defaultBranchRef { name }
            }
          }
        }
      }
    }
  `;

  const data = await fetchGraphql(query, { username, from: fromIso, to: toIso }, token);
  const collection = data?.user?.contributionsCollection;
  if (!collection) {
    throw new Error(`GitHub user not found: ${username}`);
  }

  const entries = [
    ...(collection.commitContributionsByRepository || []),
    ...(collection.pullRequestContributionsByRepository || []),
  ];

  const byRepo = new Map();
  for (const entry of entries) {
    const repo = entry.repository;
    if (!repo) {
      continue;
    }

    if (repoVisibility === "public" && repo.isPrivate) {
      continue;
    }

    if (!byRepo.has(repo.nameWithOwner)) {
      byRepo.set(repo.nameWithOwner, {
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.defaultBranchRef?.name || "",
        stars: repo.stargazerCount || 0,
      });
    }
  }

  return Array.from(byRepo.values());
}

export async function listReposForScope({ username, token, repoVisibility, repoScope, fromIso, toIso }) {
  if (repoScope === "owned") {
    return listOwnedRepos(username, token, repoVisibility);
  }

  if (repoScope === "contributed") {
    return listContributedRepos(username, fromIso, toIso, token, repoVisibility);
  }

  const [ownedRepos, contributedRepos] = await Promise.all([
    listOwnedRepos(username, token, repoVisibility),
    listContributedRepos(username, fromIso, toIso, token, repoVisibility),
  ]);

  const merged = new Map();
  for (const repo of [...ownedRepos, ...contributedRepos]) {
    merged.set(`${repo.owner}/${repo.name}`, repo);
  }

  return Array.from(merged.values());
}

export function summarizeRepoStats(repos) {
  return {
    repoCount: repos.length,
    stars: repos.reduce((sum, repo) => sum + repo.stars, 0),
  };
}

async function listRepoBranches(owner, repo, token) {
  const branches = await fetchPaginated(
    (page) => `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
    token,
  );

  return branches.map((branch) => branch.name).filter(Boolean);
}

async function aggregateRepoCommits({ owner, repo, username, branchScope, defaultBranch, fromIso, toIso, token, dayMap }) {
  const branches =
    branchScope === "all"
      ? await listRepoBranches(owner, repo, token)
      : [defaultBranch].filter(Boolean);

  let commitCount = 0;
  const seenCommitShas = new Set();

  for (const branch of branches) {
    const commits = await fetchPaginated(
      (page) =>
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&author=${encodeURIComponent(username)}&since=${encodeURIComponent(fromIso)}&until=${encodeURIComponent(toIso)}&per_page=100&page=${page}`,
      token,
    );

    for (const commit of commits) {
      const sha = commit.sha;
      if (!sha || seenCommitShas.has(sha)) {
        continue;
      }

      seenCommitShas.add(sha);
      commitCount += 1;

      const iso = commit.commit?.author?.date;
      if (iso) {
        const day = dateOnlyUtc(iso);
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
      }
    }
  }

  return commitCount;
}

async function aggregateRepoPullRequests({ owner, repo, username, fromIso, toIso, token, dayMap }) {
  const fromTime = new Date(fromIso).getTime();
  const toTime = new Date(toIso).getTime();
  let prCount = 0;

  const pulls = await fetchPaginated(
    (page) =>
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
    token,
    (pull) => new Date(pull.created_at).getTime() < fromTime,
  );

  for (const pull of pulls) {
    if (String(pull.user?.login || "").toLowerCase() !== username.toLowerCase()) {
      continue;
    }

    const created = new Date(pull.created_at).getTime();
    if (Number.isNaN(created) || created < fromTime || created > toTime) {
      continue;
    }

    prCount += 1;
    const day = dateOnlyUtc(pull.created_at);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
  }

  return prCount;
}

export async function fetchActivityFromRepos({ username, repos, fromIso, toIso, branchScope, token }) {
  const dayMap = new Map();
  let commits = 0;
  let pullRequests = 0;

  for (const repo of repos) {
    commits += await aggregateRepoCommits({
      owner: repo.owner,
      repo: repo.name,
      username,
      branchScope,
      defaultBranch: repo.defaultBranch,
      fromIso,
      toIso,
      token,
      dayMap,
    });

    pullRequests += await aggregateRepoPullRequests({
      owner: repo.owner,
      repo: repo.name,
      username,
      fromIso,
      toIso,
      token,
      dayMap,
    });
  }

  return {
    commits,
    pullRequests,
    dayMap,
  };
}

export async function fetchContributionTotals({ username, fromIso, toIso, token }) {
  if (!token) {
    return null;
  }

  const query = `
    query ContributionTotals($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          contributionCalendar {
            totalContributions
          }
        }
      }
    }
  `;

  const data = await fetchGraphql(query, { username, from: fromIso, to: toIso }, token);
  if (!data?.user?.contributionsCollection) {
    return null;
  }

  const collection = data.user.contributionsCollection;
  return {
    totalContributions: collection.contributionCalendar?.totalContributions ?? null,
    commits: collection.totalCommitContributions ?? null,
    pullRequests: collection.totalPullRequestContributions ?? null,
    issues: collection.totalIssueContributions ?? null,
    reviews: collection.totalPullRequestReviewContributions ?? null,
  };
}
