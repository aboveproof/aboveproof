import { readFileSync, writeFileSync } from "node:fs";

const USERNAME = process.env.GITHUB_USER || "aboveproof";
const TOKEN = process.env.GITHUB_TOKEN || "";

const headers = {
  "User-Agent": "aboveproof-readme-updater",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function bar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function padRight(str, len) {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function padLeft(str, len) {
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

async function main() {
  const [user, repos, events] = await Promise.all([
    gh(`/users/${USERNAME}`),
    gh(`/users/${USERNAME}/repos?per_page=100&sort=pushed`),
    gh(`/users/${USERNAME}/events/public?per_page=100`),
  ]);

  const ownRepos = repos.filter((r) => !r.fork);
  const totalStars = ownRepos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);

  // Language distribution across non-fork repos
  const langCounts = new Map();
  for (const r of ownRepos) {
    if (!r.language) continue;
    langCounts.set(r.language, (langCounts.get(r.language) || 0) + 1);
  }
  const totalWithLang = [...langCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const topLangs = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Recent push activity (last 30 days from public events)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentPushes = events.filter(
    (e) => e.type === "PushEvent" && new Date(e.created_at).getTime() >= cutoff
  );
  const recentCommits = recentPushes.reduce(
    (sum, e) => sum + (e.payload?.size ?? e.payload?.commits?.length ?? 1),
    0
  );

  // Most recently pushed non-profile repo
  const latestRepo = ownRepos.find((r) => r.name.toLowerCase() !== USERNAME.toLowerCase());

  const langLines = topLangs.map(([lang, count]) => {
    const pct = (count / totalWithLang) * 100;
    const repoLabel = `${count} ${count === 1 ? "repo" : "repos"}`;
    return `  ${padRight(lang, 14)} ${padRight(repoLabel, 10)} ${bar(pct)}  ${padLeft(pct.toFixed(1), 5)}%`;
  });

  const summaryParts = [
    `${ownRepos.length} repos`,
    `${totalStars} stars`,
    `${user.followers} followers`,
    ...(recentCommits > 0 ? [`${recentCommits} recent commits`] : []),
  ];

  const lines = [
    "```text",
    `${USERNAME}@github`,
    `${"─".repeat(58)}`,
    `  overview       ${summaryParts.join("  ·  ")}`,
    ...(latestRepo ? [`  latest push    ${latestRepo.name} (${latestRepo.language || "misc"})`] : []),
    "",
    "  languages (by repo)",
    ...langLines,
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
    console.log("Updated README.md stats block.");
  } else {
    console.log("README.md stats block already up to date.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
