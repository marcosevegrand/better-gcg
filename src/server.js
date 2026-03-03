import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { createCache } from "./cache.js";
import { fetchActivityFromRepos, fetchContributionTotals, listReposForScope, summarizeRepoStats } from "./github.js";
import { buildActivitySvg } from "./svg.js";

const app = express();
const port = process.env.PORT || 3000;
const token = process.env.GITHUB_TOKEN;
const defaultUsername = process.env.GITHUB_USERNAME || "octocat";
const cacheTtlHours = Number(process.env.CACHE_TTL_HOURS || 6);
const cache = createCache(cacheTtlHours * 60 * 60 * 1000);

function parseMonths(value) {
  const parsed = Number(value || 12);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24) {
    throw new Error("Query param 'months' must be an integer between 1 and 24.");
  }
  return parsed;
}

function parseThresholds(value) {
  const defaults = [1, 3, 6, 10];
  if (!value) {
    return defaults;
  }

  const parsed = String(value)
    .split(",")
    .map((item) => Number(item.trim()));

  if (parsed.length !== 4 || parsed.some((item) => !Number.isFinite(item) || item < 1)) {
    throw new Error("Query param 'thresholds' must be 4 positive integers, e.g. 1,3,6,10.");
  }

  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index] <= parsed[index - 1]) {
      throw new Error("Query param 'thresholds' must be strictly increasing (e.g. 1,3,6,10).");
    }
  }

  return parsed;
}

function parseRepoVisibility(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  if (normalized !== "public" && normalized !== "all") {
    throw new Error("Query param 'repo_visibility' must be 'public' or 'all'.");
  }
  return normalized;
}

function parseBranchScope(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  if (normalized !== "default" && normalized !== "all") {
    throw new Error("Query param 'branch_scope' must be 'default' or 'all'.");
  }
  return normalized;
}

function parseRepoScope(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  if (!["owned", "contributed", "all"].includes(normalized)) {
    throw new Error("Query param 'repo_scope' must be 'owned', 'contributed', or 'all'.");
  }
  return normalized;
}

function isoRangeForMonths(months) {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0));
  from.setUTCMonth(from.getUTCMonth() - months);
  from.setUTCDate(from.getUTCDate() + 1);
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59));
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function etagFor(content) {
  return `W/\"${crypto.createHash("sha1").update(content).digest("hex")}\"`;
}

function previewPage({ username = defaultUsername, months = 12, thresholds = "1,3,6,10", repoVisibility = "all", branchScope = "all", repoScope = "all" }) {
  const selectedRepoVisibility = ["public", "all"].includes(repoVisibility) ? repoVisibility : "all";
  const selectedBranchScope = ["default", "all"].includes(branchScope) ? branchScope : "all";
  const selectedRepoScope = ["owned", "contributed", "all"].includes(repoScope) ? repoScope : "all";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>pretty-me preview</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial;
        background: #0d1117;
        color: #c9d1d9;
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
      }
      p {
        margin: 0 0 18px;
        color: #8b949e;
      }
      .url-row {
        display: flex;
        gap: 8px;
        margin: 0 0 16px;
        align-items: center;
      }
      form {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: end;
        margin-bottom: 18px;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: #8b949e;
      }
      input {
        background: #161b22;
        border: 1px solid #30363d;
        color: #c9d1d9;
        border-radius: 6px;
        padding: 8px 10px;
        min-width: 140px;
      }
      select {
        background: #161b22;
        border: 1px solid #30363d;
        color: #c9d1d9;
        border-radius: 6px;
        padding: 8px 10px;
        min-width: 140px;
      }
      button {
        background: #238636;
        color: white;
        border: none;
        border-radius: 6px;
        padding: 9px 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .copy-btn {
        background: #21262d;
        border: 1px solid #30363d;
      }
      .card {
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 10px;
        padding: 16px;
        overflow: auto;
      }
      img {
        display: block;
        max-width: 100%;
        height: auto;
      }
      code {
        color: #8b949e;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>pretty-me SVG preview</h1>
      <p>Tune the parameters and preview the generated SVG.</p>
      <form id="preview-form">
        <label>
          Username
          <input id="username" name="username" value="${username}" required />
        </label>
        <label>
          Months (1-24)
          <input id="months" name="months" type="number" min="1" max="24" value="${months}" required />
        </label>
        <label>
          Thresholds (4 values)
          <input id="thresholds" name="thresholds" value="${thresholds}" required />
        </label>
        <label>
          Repo visibility
          <select id="repo_visibility" name="repo_visibility" required>
            <option value="public" ${selectedRepoVisibility === "public" ? "selected" : ""}>public</option>
            <option value="all" ${selectedRepoVisibility === "all" ? "selected" : ""}>all</option>
          </select>
        </label>
        <label>
          Branch scope
          <select id="branch_scope" name="branch_scope" required>
            <option value="default" ${selectedBranchScope === "default" ? "selected" : ""}>default</option>
            <option value="all" ${selectedBranchScope === "all" ? "selected" : ""}>all</option>
          </select>
        </label>
        <label>
          Repo scope
          <select id="repo_scope" name="repo_scope" required>
            <option value="owned" ${selectedRepoScope === "owned" ? "selected" : ""}>owned</option>
            <option value="contributed" ${selectedRepoScope === "contributed" ? "selected" : ""}>contributed</option>
            <option value="all" ${selectedRepoScope === "all" ? "selected" : ""}>all</option>
          </select>
        </label>
        <button id="preview-btn" type="button">Preview</button>
      </form>
      <div class="url-row">
        <input id="live-url" aria-label="Live endpoint URL" readonly />
        <button id="copy-url" type="button" class="copy-btn">Copy URL</button>
      </div>
      <div class="card">
        <img id="svg" alt="GitHub activity SVG preview" />
      </div>
    </main>
    <script>
      const form = document.getElementById("preview-form");
      const image = document.getElementById("svg");
      const liveUrlInput = document.getElementById("live-url");
      const copyButton = document.getElementById("copy-url");
      const previewButton = document.getElementById("preview-btn");

      function buildEndpoint() {
        const username = document.getElementById("username").value.trim();
        const months = document.getElementById("months").value.trim();
        const thresholds = document.getElementById("thresholds").value.trim();
        const repoVisibility = document.getElementById("repo_visibility").value.trim();
        const branchScope = document.getElementById("branch_scope").value.trim();
        const repoScope = document.getElementById("repo_scope").value.trim();
        const src = "/api/svg/" + encodeURIComponent(username) + "?months=" + encodeURIComponent(months) + "&thresholds=" + encodeURIComponent(thresholds) + "&repo_visibility=" + encodeURIComponent(repoVisibility) + "&branch_scope=" + encodeURIComponent(branchScope) + "&repo_scope=" + encodeURIComponent(repoScope);

        return { src, username, months, thresholds, repoVisibility, branchScope, repoScope };
      }

      function renderPreview() {
        const { src, username, months, thresholds, repoVisibility, branchScope, repoScope } = buildEndpoint();

        const absoluteUrl = window.location.origin + src;
        liveUrlInput.value = absoluteUrl;
        image.src = src + "&_t=" + Date.now();

        const search = new URLSearchParams({ username, months, thresholds, repo_visibility: repoVisibility, branch_scope: branchScope, repo_scope: repoScope });
        history.replaceState(null, "", "/preview?" + search.toString());
      }

      previewButton.addEventListener("click", () => {
        renderPreview();
      });

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        renderPreview();
      });

      copyButton.addEventListener("click", async () => {
        const value = liveUrlInput.value;
        if (!value) {
          return;
        }

        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
          } else {
            liveUrlInput.focus();
            liveUrlInput.select();
            document.execCommand("copy");
          }
          copyButton.textContent = "Copied";
          setTimeout(() => {
            copyButton.textContent = "Copy URL";
          }, 900);
        } catch {
          copyButton.textContent = "Copy failed";
          setTimeout(() => {
            copyButton.textContent = "Copy URL";
          }, 1200);
        }
      });

      liveUrlInput.value = window.location.origin + buildEndpoint().src;
    </script>
  </body>
</html>`;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Use /api/svg/:username?months=12&thresholds=1,3,6,10&repo_visibility=all&branch_scope=all&repo_scope=all",
  );
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.get("/preview", (req, res) => {
  const username = String(req.query.username || defaultUsername).trim();
  const months = Number(req.query.months || 12);
  const thresholds = String(req.query.thresholds || "1,3,6,10").trim();
  const repoVisibility = String(req.query.repo_visibility || "all").trim();
  const branchScope = String(req.query.branch_scope || "all").trim();
  const repoScope = String(req.query.repo_scope || "all").trim();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(previewPage({ username, months, thresholds, repoVisibility, branchScope, repoScope }));
});

app.get("/api/svg/:username", async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      res.status(400).json({ error: "GitHub username is required in the path." });
      return;
    }

    const months = parseMonths(req.query.months);
    const thresholds = parseThresholds(req.query.thresholds);
    const repoVisibility = parseRepoVisibility(req.query.repo_visibility);
    const branchScope = parseBranchScope(req.query.branch_scope);
    const repoScope = parseRepoScope(req.query.repo_scope);
    const cacheKey = `${username}|${months}|${thresholds.join(",")}|${repoVisibility}|${branchScope}|${repoScope}`;
    const cachedSvg = cache.get(cacheKey);

    if (cachedSvg) {
      const etag = etagFor(cachedSvg);
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400");
      res.setHeader("ETag", etag);
      res.send(cachedSvg);
      return;
    }

    const { fromIso, toIso } = isoRangeForMonths(months);
    const repos = await listReposForScope({
      username,
      token,
      repoVisibility,
      repoScope,
      fromIso,
      toIso,
    });
    const repoStats = summarizeRepoStats(repos);
    const contributions = await fetchActivityFromRepos({
      username,
      repos,
      fromIso,
      toIso,
      branchScope,
      token,
    });
    const totals = await fetchContributionTotals({ username, fromIso, toIso, token });

    const svg = buildActivitySvg({
      username,
      months,
      thresholds,
      repos: repoStats.repoCount,
      commits: totals?.commits ?? contributions.commits,
      pullRequests: totals?.pullRequests ?? contributions.pullRequests,
      totalContributions: totals?.totalContributions ?? null,
      stars: repoStats.stars,
      dayMap: contributions.dayMap,
      generatedAt: new Date().toISOString().replace("T", " ").replace(".000Z", " UTC"),
    });

    cache.set(cacheKey, svg);

    const etag = etagFor(svg);
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400");
    res.setHeader("ETag", etag);
    res.send(svg);
  } catch (error) {
    res.status(400).json({
      error: error.message || "Failed to generate SVG.",
      hint: "Provide valid username/months/thresholds/repo_visibility/branch_scope/repo_scope. For private or contributed scope, set GITHUB_TOKEN.",
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`pretty-me service listening on http://localhost:${port}`);
  });
}

export default app;
