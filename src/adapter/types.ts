import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StateFile, Mail, ThreadSummary } from "../core/types";

export type ThreadingFlagKey<TParam extends string> = `thread-storage-${TParam}`;
export type AdapterOptionKey<TFlag = string> =
  TFlag extends ThreadingFlagKey<infer B> ? B : never;

export type AdapterFlags<B extends string = string> = Record<ThreadingFlagKey<B>, string | boolean>;

export type PiFlagParam = {
  type: "string" | "boolean";
  description: string;
  default?: string;
};

export type AdapterOptions<TFlags extends Record<string, PiFlagParam>> = {
  [K in keyof TFlags]: TFlags[K] extends PiFlagParam
    ? TFlags[K]["type"] extends "string"
      ? string
      : boolean
    : never;
};

export interface StorageAdapter {
  configure(): Promise<void>;

  loadState(threadId: string): Promise<StateFile | undefined>;
  saveState(threadId: string, state: StateFile): Promise<void>;

  listThreads(): Promise<ThreadSummary[]>;
  threadExists(threadId: string): Promise<boolean>;

  sendMail(mail: Mail): Promise<void>;
  receiveMail(threadId: string): Promise<Mail[]>;
  watchMail(threadId: string, cb: () => void): () => void;
}

export interface JournalAdapter {
  appendJournal(threadId: string, entry: string): Promise<void>;
  readJournal(threadId: string): Promise<string | undefined>;
}

export type ThreadAdapter = StorageAdapter & Partial<JournalAdapter>;

export interface AdapterDefinition<
  TFlags extends Record<string, PiFlagParam> = Record<string, PiFlagParam>,
> {
  options: TFlags;
  build(pi: ExtensionAPI): ThreadAdapter;
}
