import { readFile, stat } from "node:fs/promises";

const [owner, repository, baseOid, message, ...files] = process.argv.slice(2);
if (!owner || !repository || !baseOid || !message || files.length === 0) {
  console.error("usage: create-commit-on-branch.mjs owner repo baseOid message files...");
  process.exit(1);
}

const additions = await Promise.all(
  files.map(async (file) => {
    await stat(file);
    return {
      path: file,
      contents: Buffer.from(await readFile(file)).toString("base64"),
    };
  }),
);

console.log(
  JSON.stringify({
    query: `mutation ($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
        }
      }
    }`,
    variables: {
      input: {
        branch: {
          repositoryNameWithOwner: `${owner}/${repository}`,
          branchName: "main",
        },
        expectedHeadOid: baseOid,
        fileChanges: { additions },
        message: {
          headline: message,
        },
      },
    },
  }),
);
