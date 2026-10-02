export interface Post {
  id: string;
  subreddit: string;
  title: string;
  selftext: string;
  url: string;
  createdUtc: number; // секунды UTC
  numComments: number;
  author: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  landing: string;
  subreddits: string[];
  queries?: string[];
  keywords: { any: string[]; exclude?: string[] };
  maxAgeHours: number;
  threshold: number;
}

export interface Project extends ProjectConfig {
  voice: string;
}

export interface Verdict {
  relevant: number;
  reason: string;
  draft: string;
}

export interface Card {
  project: Project;
  post: Post;
  verdict: Verdict | null; // null = модель не ответила
}
