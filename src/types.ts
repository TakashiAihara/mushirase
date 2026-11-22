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

export type Kind = "pre-announcement" | "release" | "report";

export type Notice = {
  item: FeedItem;
  kind: Kind;
  hits: Asset[];
  note?: string;
};
