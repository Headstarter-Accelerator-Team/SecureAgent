import { Octokit } from "@octokit/rest";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { MemoryVectorStore } from "langchain/vectorstores/memory";

interface RepoFile {
  path: string;
  content: string;
}

export class RepositoryEmbedder {
  private octokit: Octokit;
  private vectorStore: MemoryVectorStore | null = null;
  private embeddings: HuggingFaceTransformersEmbeddings;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
    this.embeddings = new HuggingFaceTransformersEmbeddings({
      modelName: "sentence-transformers/all-MiniLM-L6-v2",
    });
  }

  private async getAllFiles(
    owner: string,
    repo: string,
    path: string = ""
  ): Promise<RepoFile[]> {
    const { data: contents } = await this.octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    const files: RepoFile[] = [];

    for (const item of Array.isArray(contents) ? contents : [contents]) {
      if (item.type === "file" && this.isCodeFile(item.name)) {
        const content = Buffer.from(item.content, "base64").toString("utf-8");
        files.push({ path: item.path, content });
      } else if (item.type === "dir") {
        const subFiles = await this.getAllFiles(owner, repo, item.path);
        files.push(...subFiles);
      }
    }

    return files;
  }

  private isCodeFile(filename: string): boolean {
    const codeExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".go",
      ".rb",
      ".php",
      ".rs",
      ".swift",
      ".kt",
    ]);
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    return codeExtensions.has(ext);
  }

  async embedRepository(owner: string, repo: string) {
    const files = await this.getAllFiles(owner, repo);

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const documents = await Promise.all(
      files.map(async (file) => {
        const chunks = await textSplitter.createDocuments(
          [file.content],
          [{ path: file.path }]
        );
        return chunks;
      })
    );

    const flatDocuments = documents.flat();

    this.vectorStore = await MemoryVectorStore.fromDocuments(
      flatDocuments,
      this.embeddings
    );
  }

  async similaritySearch(query: string, k: number = 5) {
    if (!this.vectorStore) {
      throw new Error("Repository not embedded yet");
    }
    return await this.vectorStore.similaritySearch(query, k);
  }
}
