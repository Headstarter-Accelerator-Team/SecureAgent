import {
  BranchDetails,
  BuilderResponse,
  CodeSuggestion,
  PRFile,
  Review,
  processGitFilepath,
} from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { Pinecone } from "@pinecone-database/pinecone";
import { Document } from "langchain/document";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";

const postGeneralReviewComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  review: string
) => {
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.pull_request.number,
        body: review,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(exc);
  }
};

const postInlineComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  suggestion: CodeSuggestion
) => {
  try {
    const line = suggestion.line_end;
    let startLine = null;
    if (suggestion.line_end != suggestion.line_start) {
      startLine = suggestion.line_start;
    }
    const suggestionBody = `${suggestion.comment}\n\`\`\`suggestion\n${suggestion.correction}`;

    await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: payload.pull_request.number,
        body: suggestionBody,
        commit_id: payload.pull_request.head.sha,
        path: suggestion.file,
        line: line,
        ...(startLine ? { start_line: startLine } : {}),
        // position: suggestion.line_start,
        // subject_type: "line",
        start_side: "RIGHT",
        side: "RIGHT",
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(exc);
  }
};

export const applyReview = async ({
  octokit,
  payload,
  review,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
  review: Review;
}) => {
  let commentPromise = null;
  const comment = review.review?.comment;
  if (comment != null) {
    commentPromise = postGeneralReviewComment(octokit, payload, comment);
  }
  const suggestionPromises = review.suggestions.map((suggestion) =>
    postInlineComment(octokit, payload, suggestion)
  );
  await Promise.all([
    ...(commentPromise ? [commentPromise] : []),
    ...suggestionPromises,
  ]);
};

const addLineNumbers = (contents: string) => {
  const rawContents = String.raw`${contents}`;
  const prepended = rawContents
    .split("\n")
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n");
  return prepended;
};

export const getGitFile = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"] | WebhookEventMap["pull_request"],
  branch: BranchDetails,
  filepath: string
) => {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        path: filepath,
        ref: branch.name, // specify the branch name here
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    // Check if response.data is a single file (not an array)
    if (Array.isArray(response.data) || !("content" in response.data)) {
      return { content: null, sha: null };
    }
    //@ts-ignore
    const decodedContent = Buffer.from(
      response.data.content,
      "base64"
    ).toString("utf8");

    // After getting the file content, store it in Pinecone
    await storeCodeInPinecone(filepath, decodedContent, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    //@ts-ignore
    return { content: decodedContent, sha: response.data.sha };
  } catch (exc) {
    if (exc.status === 404) {
      return { content: null, sha: null };
    }
    console.log(exc);
    throw exc;
  }
};

export const getFileContents = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"],
  branch: BranchDetails,
  filepath: string
) => {
  const gitFile = await getGitFile(
    octokit,
    payload,
    branch,
    processGitFilepath(filepath)
  );
  const fileWithLines = `# ${filepath}\n${addLineNumbers(gitFile.content)}`;
  return { result: fileWithLines, functionString: `Opening file: ${filepath}` };
};

export const commentIssue = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"],
  comment: string
) => {
  await octokit.rest.issues.createComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.issue.number,
    body: comment,
  });
};

export const createBranch = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"]
) => {
  let branchDetails = null;
  try {
    const title = payload.issue.title.replace(/\s/g, "-").substring(0, 15);

    const hash = Math.random().toString(36).substring(2, 7);
    const subName = `${title}-${hash}`.substring(0, 20);
    const branchName = `Code-Bot/${subName}`;
    // Get the default branch for the repository
    const { data: repo } = await octokit.rest.repos.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    // Get the commit SHA of the default branch
    const { data: ref } = await octokit.rest.git.getRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `heads/${repo.default_branch}`,
    });

    // Create a new branch from the commit SHA
    const { data: newBranch } = await octokit.rest.git.createRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });

    console.log(newBranch);

    branchDetails = {
      name: branchName,
      sha: newBranch.object.sha,
      url: newBranch.url,
    };
    let branchUrl = `https://github.com/${payload.repository.owner.login}/${payload.repository.name}/tree/${branchName}`;
    const branchComment = `Branch created: [${branchName}](${branchUrl})`;
    await commentIssue(octokit, payload, branchComment);

    console.log(`Branch ${branchName} created`);
  } catch (exc) {
    console.log(exc);
  }
  return branchDetails;
};

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENVIRONMENT = process.env.PINECONE_ENVIRONMENT;

const pinecone = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

const embedder = new HuggingFaceTransformersEmbeddings({
  modelName: "Xenova/all-MiniLM-L6-v2",
});
// Function to store code in Pinecone
const storeCodeInPinecone = async (
  filepath: string,
  content: string,
  repoInfo: { owner: string; repo: string }
) => {
  const index = pinecone.Index("code-embeddings");
  const namespace = "code files"; // Fixed namespace

  // Split code into chunks
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const docs = await splitter.createDocuments(
    [content],
    [
      {
        filepath,
        repo: `${repoInfo.owner}/${repoInfo.repo}`,
      },
    ]
  );

  // Create embeddings and store in Pinecone
  const vectors = await Promise.all(
    docs.map(async (doc, i) => {
      const embedding = await embedder.embedQuery(doc.pageContent);
      console.log(`Embedding created for ${doc.metadata.filepath}`);

      // Extract additional metadata
      const functionMetadata = extractFunctionMetadata(doc.pageContent);
      const functionName = functionMetadata?.name || "";
      const functionParams = functionMetadata?.params.join(", ") || "";
      const returnType = functionMetadata?.returnType || "";

      // Flatten and filter metadata
      const metadata = {
        filepath: String(doc.metadata.filepath || ""),
        repo: String(doc.metadata.repo || ""),
        content: String(doc.pageContent || ""),
        chunk_index: String(i),
        function_name: functionName,
        function_params: functionParams,
        return_type: returnType,
        ...(doc.metadata.loc?.lines
          ? {
              line_range: `${doc.metadata.loc.lines.from || ""}-${
                doc.metadata.loc.lines.to || ""
              }`,
            }
          : {}),
      };

      return {
        id: `${filepath}-${i}`,
        values: embedding,
        metadata: Object.fromEntries(
          Object.entries(metadata).filter(
            ([_, value]) => typeof value === "string" && value !== ""
          )
        ),
      };
    })
  );

  console.log(
    `Upserting ${vectors.length} vectors to Pinecone under namespace "code files"`
  );
  await index.namespace(namespace).upsert(vectors); // Add namespace here
};

export const getRelevantCodeContext = async (query: string) => {
  const index = pinecone.Index("code-embeddings");
  const namespace = "code files";

  const queryEmbedding = await embedder.embedQuery(query);

  const results = await index.namespace(namespace).query({
    vector: queryEmbedding,
    topK: 20,
    includeMetadata: true,
  });

  return results.matches.map((match) => ({
    content: match.metadata.content,
    filepath: match.metadata.filepath,
    repo: match.metadata.repo,
    score: match.score,
  }));
};

export const getContextForReview = async (files: PRFile[]) => {
  const contexts = await Promise.all(
    files.map(async (file) => {
      // Use the new code content as query to find similar code
      const query = file.current_contents || "";
      const relevantCode = await getRelevantCodeContext(query);

      return {
        filename: file.filename,
        similarCode: relevantCode
          .filter(
            (code) =>
              // Filter out the same file
              code.filepath !== file.filename &&
              // Keep only highly relevant results
              code.score > 0.8
          )
          .slice(0, 3), // Keep top 3 most relevant
      };
    })
  );

  return contexts.filter((ctx) => ctx.similarCode.length > 0);
};

// Define the extractFunctionName function
const extractFunctionName = (code: string): string | null => {
  const functionMatch = code.match(/function\s+([a-zA-Z0-9_]+)/);
  return functionMatch ? functionMatch[1] : null;
};

// Define the extractClassName function
const extractClassName = (code: string): string | null => {
  const classMatch = code.match(/class\s+([a-zA-Z0-9_]+)/);
  return classMatch ? classMatch[1] : null;
};

const extractFunctionMetadata = (
  code: string
): { name: string; params: string[]; returnType: string } | null => {
  const functionMatch = code.match(
    /function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*:\s*([a-zA-Z0-9_]+)/
  );
  if (functionMatch) {
    const [, name, params, returnType] = functionMatch;
    return {
      name,
      params: params.split(",").map((param) => param.trim()),
      returnType,
    };
  }
  return null;
};

// Function to list all files in a repository
const listAllFilesInRepo = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  path = ""
): Promise<string[]> => {
  const files = [];
  const { data: repoContent } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
  });

  if (Array.isArray(repoContent)) {
    for (const item of repoContent) {
      if (item.type === "file") {
        files.push(item.path);
      } else if (item.type === "dir") {
        const subDirFiles = await listAllFilesInRepo(
          octokit,
          owner,
          repo,
          item.path
        );
        files.push(...subDirFiles);
      }
    }
  } else if (repoContent.type === "file") {
    files.push(repoContent.path);
  }
  return files;
};

const filterEmbeddingFile = (filepath: string): boolean => {
  const extensionsToInclude = new Set<string>([
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "java",
    "cpp",
    "c",
    "cs",
    "go",
    "rs",
    "php",
    "rb",
    "swift",
    "kt",
  ]);

  const splitFilename = filepath.toLowerCase().split(".");
  if (splitFilename.length <= 1) {
    console.log(`Filtering out file with no extension: ${filepath}`);
    return false;
  }

  const extension = splitFilename.pop()?.toLowerCase();
  if (!extension || !extensionsToInclude.has(extension)) {
    console.log(`Filtering out non-code file: ${filepath} (.${extension})`);
    return false;
  }
  return true;
};

// Function to process all files in the repository
export const processAllRepoFiles = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"]
) => {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  const files = await listAllFilesInRepo(octokit, owner, repo);
  const filteredFiles = files.filter(filterEmbeddingFile);

  // Fetch the default branch details dynamically
  const { data: repoData } = await octokit.rest.repos.get({
    owner,
    repo,
  });

  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${repoData.default_branch}`,
  });

  const branchDetails: BranchDetails = {
    name: repoData.default_branch,
    sha: ref.object.sha,
    url: `https://github.com/${owner}/${repo}/tree/${repoData.default_branch}`,
  };

  for (const filepath of filteredFiles) {
    const gitFile = await getGitFile(octokit, payload, branchDetails, filepath);
    if (gitFile.content) {
      await storeCodeInPinecone(filepath, gitFile.content, { owner, repo });
    }
  }
};
