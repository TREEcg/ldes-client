import { RdfDereferencer } from "rdf-dereference";
import { Notifier } from "./utils";
import { extractRelations, Relation } from "./page";
import debug from "debug";
import { SimpleRelation } from "./relation";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
const log = debug("fetcher");
const { namedNode } = new DataFactory();

/**
 * target: url to fetch
 * expected: relations that can be found, and should be ignored
 *   examples are the originating url
 */
export type Node = {
  target: string;
  expected: string[];
};

export type FetchedPage = {
  url: string;
  data: RdfStore;
};

// At most concurrentRequests + maxFetched pages will be stored in memory
// First maxFetched can be ready, but already concurrentRequests are sent out
export type FetcherConfig = {
  concurrentRequests: number;
  maxFetched: number;
};

export const DefaultFetcherConfig: FetcherConfig = {
  concurrentRequests: 10,
  maxFetched: 10,
};

export type LongPromise = {
  waiting: Promise<void>;
  callback: () => void;
};

export function longPromise(): LongPromise {
  const out = {} as LongPromise;
  out.waiting = new Promise((res) => (out.callback = res));
  return out;
}

export function resetPromise(promise: LongPromise) {
  const cb = promise.callback;
  promise.waiting = new Promise((res) => (promise.callback = res));
  cb();
}

export interface Helper {
  extractRelation(relation: Relation): { rel: SimpleRelation; node: string };
  handleFetchedPage(page: FetchedPage, marker?: any): void | Promise<void>;
  close(): void | Promise<void>;
}

export type FetchEvent = {
  relationFound: { from: Node; target: Relation };
  pageFetched: FetchedPage;
  scheduleFetch: Node;
  error: any;
};

export type Cache = {
  immutable?: boolean;
  maxAge?: number;
};

export class Fetcher {
  private dereferencer: RdfDereferencer;
  private loose: boolean;
  private fetch_f?: typeof fetch;
  private after?: Date;
  private before?: Date;

  constructor(
    dereferencer: RdfDereferencer,
    loose: boolean,
    fetch_f?: typeof fetch,
    after?: Date,
    before?: Date,
  ) {
    this.dereferencer = dereferencer;
    this.loose = loose;
    this.fetch_f = fetch_f;
    if (after) this.after = after;
    if (before) this.before = before;
  }

  async fetch<S>(node: Node, state: S, notifier: Notifier<FetchEvent, S>) {
    const logger = log.extend("fetch");

    try {
      const resp = await this.dereferencer.dereference(node.target, {
        localFiles: true,
        fetch: this.fetch_f,
      });

      node.target = resp.url;

      const cache = {} as Cache;
      if (resp.headers) {
        const cacheControlCandidate = resp.headers.get("cache-control");
        if (cacheControlCandidate) {
          const controls = cacheControlCandidate
            .split(",")
            .map((x) => x.split("=", 2).map((x) => x.trim()));

          for (let control of controls) {
            if (control[0] == "max-age") {
              cache.maxAge = parseInt(control[1]);
            }

            if (control[0] == "immutable") {
              cache.immutable = true;
            }
          }
        }
      }

      if (!cache.immutable) {
        notifier.scheduleFetch(node, state);
      }

      logger("Cache for  %s %o", node.target, cache);

      const data = RdfStore.createDefault();
      let quadCount = 0;
      await new Promise((resolve, reject) => {
        resp.data
          .on("data", (quad) => {
            data.addQuad(quad);
            quadCount++;
          })
          .on("end", resolve)
          .on("error", reject);
      });
      logger("Got data %s (%d quads)", node.target, quadCount);

      for (let rel of extractRelations(
        data,
        namedNode(resp.url),
        this.loose,
        this.after,
        this.before,
      )) {
        if (!node.expected.some((x) => x == rel.node)) {
          notifier.relationFound({ from: node, target: rel }, state);
        }
      }

      // TODO check this, is node.target correct?
      notifier.pageFetched({ data, url: resp.url }, state);
    } catch (ex) {
      notifier.error(ex, state);
      notifier.pageFetched(
        { data: RdfStore.createDefault(), url: node.target },
        state,
      );
    }
  }
}
