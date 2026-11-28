import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USERNAME = process.env.GITHUB_USER || "aboveproof";
const TOKEN = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN || "";

const headers = {
  "User-Agent": "aboveproof-readme-updater",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".turbo",
  ".svelte-kit",
  ".astro",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "github-metrics.svg",
]);

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyw",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".rs",
  ".go",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".cs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".lua",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".vue",
  ".svelte",
  ".astro",
]);

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchAllRepos() {
  const all = [];
  let useAuthEndpoint = Boolean(TOKEN);

  for (let page = 1; page <= 10; page++) {
    let batch;
    if (useAuthEndpoint) {
      try {
        batch = await gh(
          `/user/repos?affiliation=owner&visibility=all&per_page=100&sort=pushed&page=${page}`
        );
      } catch {
        useAuthEndpoint = false;
        page = 0;
        all.length = 0;
        continue;
      }
    } else {
      batch = await gh(`/users/${USERNAME}/repos?per_page=100&sort=pushed&page=${page}`);
    }

    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }

  return all;
}

function countDirLines(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      total += countDirLines(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (SKIP_FILES.has(lower) || lower.endsWith(".min.js") || lower.endsWith(".min.css")) {
      continue;
    }
    if (!CODE_EXTS.has(extname(lower))) continue;

    try {
      const buf = readFileSync(fullPath);
      if (buf.length === 0 || buf.length > 2 * 1024 * 1024) continue;
      if (buf.includes(0)) continue;

      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) total++;
      }
    } catch {
      // ignore unreadable files
    }
  }

  return total;
}

async function countRepoLines(repo, workRoot) {
  if (!repo.size) return 0;

  const targetDir = join(workRoot, repo.name);
  const args = [];
  if (TOKEN) {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    args.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`);
  }
  args.push("clone", "--depth", "1", "--quiet", repo.clone_url, targetDir);

  try {
    await execFileAsync("git", args, {
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return countDirLines(targetDir);
  } catch (err) {
    console.warn(`Skipped ${repo.private ? "(private repo)" : repo.name}: ${err.message}`);
    return 0;
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fmtNum(n) {
  return n.toLocaleString("en-US");
}

async function main() {
  const [user, ownRepos, events] = await Promise.all([
    gh(`/users/${USERNAME}`),
    fetchAllRepos(),
    gh(`/users/${USERNAME}/events/public?per_page=100`),
  ]);

  const publicRepos = ownRepos.filter((r) => !r.private);
  const privateRepos = ownRepos.filter((r) => r.private);
  const totalStars = publicRepos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);

  const workRoot = mkdtempSync(join(tmpdir(), "aboveproof-loc-"));
  let publicLines = 0;
  let privateLines = 0;

  try {
    const counts = await mapWithConcurrency(ownRepos, 4, (repo) => countRepoLines(repo, workRoot));
    for (let i = 0; i < ownRepos.length; i++) {
      if (ownRepos[i].private) privateLines += counts[i];
      else publicLines += counts[i];
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  const totalLines = publicLines + privateLines;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentPushes = events.filter(
    (e) => e.type === "PushEvent" && new Date(e.created_at).getTime() >= cutoff
  );
  const recentCommits = recentPushes.reduce(
    (sum, e) => sum + (e.payload?.size ?? e.payload?.commits?.length ?? 1),
    0
  );

  const latestPublicRepo = publicRepos.find(
    (r) => r.name.toLowerCase() !== USERNAME.toLowerCase()
  );

  const reposSummary =
    privateRepos.length > 0
      ? `${ownRepos.length} total (${publicRepos.length} public, ${privateRepos.length} private)`
      : `${publicRepos.length} public`;

  const locSummary =
    privateLines > 0
      ? `${fmtNum(totalLines)} (${fmtNum(publicLines)} public, ${fmtNum(privateLines)} private)`
      : `${fmtNum(totalLines)}`;

  const statsParts = [
    `${totalStars} stars`,
    `${user.followers} followers`,
    ...(recentCommits > 0 ? [`${recentCommits} recent commits`] : []),
  ];

  const lines = [
    "```text",
    `${USERNAME}@github`,
    `${"─".repeat(60)}`,
    `  repos          ${reposSummary}`,
    `  lines of code  ${locSummary}`,
    `  activity       ${statsParts.join("  ·  ")}`,
    ...(latestPublicRepo
      ? [`  latest push    ${latestPublicRepo.name} (${latestPublicRepo.language || "misc"})`]
      : []),
    "```",
  ];

  const block = lines.join("\n");
  const readmePath = "README.md";
  const readme = readFileSync(readmePath, "utf8");
  const startTag = "<!--START_SECTION:stats-->";
  const endTag = "<!--END_SECTION:stats-->";

  const startIdx = readme.indexOf(startTag);
  const endIdx = readme.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find START_SECTION:stats / END_SECTION:stats markers in README.md");
  }

  const updated =
    readme.slice(0, startIdx + startTag.length) +
    "\n" +
    block +
    "\n" +
    readme.slice(endIdx);

  if (updated !== readme) {
    writeFileSync(readmePath, updated, "utf8");
    console.log(`Updated README.md (${fmtNum(totalLines)} lines across ${ownRepos.length} repos).`);
  } else {
    console.log("README.md stats block already up to date.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
