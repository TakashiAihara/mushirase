export type Asset = {
  name: string;
  version?: string;
  source: string;
};

export type FeedItem = {
  id: string;
  feed: string;
  title: string;
  link: string;
  summary: string;
  published?: string;
};

export type Kind = "pre-announcement" | "fix";

export type Notice = {
  item: FeedItem;
  kind: Kind;
  hits: Asset[];
  // Which wording made the item count as a vulnerability notice, shown so a reader can judge the match.
  why?: string;
  note?: string;
};
