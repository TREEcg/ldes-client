import { Manager, MemberEvents } from "../memberManager";
import { FetchedPage, Fetcher, FetchEvent, Node } from "../pageFetcher";
import { Modulator, ModulatorFactory, Notifier } from "../utils";

import { StrategyEvents } from ".";

import debug from "debug";

const log = debug("strategy");

export class UnorderedStrategy {
  private manager: Manager;
  private fetcher: Fetcher;
  private notifier: Notifier<StrategyEvents, {}>;

  private inFlight: number = 0;

  private fetchNotifier: Notifier<FetchEvent, { index: number }>;
  private memberNotifier: Notifier<MemberEvents, {}>;

  private modulator: Modulator<Node>;

  private cacheList: Node[] = [];
  private polling: boolean;
  private pollInterval?: number;

  private cancled = false;

  constructor(
    memberManager: Manager,
    fetcher: Fetcher,
    notifier: Notifier<StrategyEvents, {}>,
    modulatorFactory: ModulatorFactory,
    polling: boolean,
    pollInterval?: number,
  ) {
    this.pollInterval = pollInterval;
    this.notifier = notifier;
    this.manager = memberManager;
    this.fetcher = fetcher;
    this.polling = polling;

    const fetchLogger = log.extend("fetch");
    // Callbacks for the fetcher
    // - seen: the strategy wanted to fetch an uri, but it was already seen
    //         so one fetch request is terminated, inFlight -= 1
    // - pageFetched: a complete page is fetched and the relations have been extracted
    //         start member extraction
    // - relationFound: a relation has been found, inFlight += 1 and put it in the queue
    this.fetchNotifier = {
      error: (error: any) => {
        fetchLogger("error %o", error);
        this.notifier.error(error, {});
      },
      scheduleFetch: (node: Node) => {
        this.cacheList.push(node);
        this.notifier.mutable({}, {});
      },
      pageFetched: (page, { index }) => {
        fetchLogger("Paged fetched %s", page.url);
        this.handleFetched(page, index);
      },
      relationFound: ({ from, target }) => {
        from.expected.push(target.node);
        this.inFlight += 1;
        this.modulator.push({ target: target.node, expected: [from.target] });
      },
    };

    // Callbacks for the member extractor
    // - done: all members have been extracted, we are finally done with a page inFlight -= 1
    // - extracted: a member has been found, yeet it
    this.memberNotifier = {
      done: () => {
        this.inFlight -= 1;
        this.checkEnd();
        this.notifier.fragment({}, {});
      },
      extracted: (mem) => this.notifier.member(mem, {}),
    };

    this.modulator = modulatorFactory.create<Node>("fetcher", [], {
      ready: ({ item, index }) =>
        this.fetcher.fetch(item, { index }, this.fetchNotifier),
    });
  }

  start(url: string) {
    const logger = log.extend("start");
    this.inFlight = this.modulator.length();
    if (this.inFlight < 1) {
      this.inFlight = 1;
      this.modulator.push({ target: url, expected: [] });
      logger("Nothing in flight, adding start url");
    } else {
      logger("Things are already inflight, not adding start url");
    }
  }

  cancle() {
    this.cancled = true;
  }

  private handleFetched(page: FetchedPage, index: number) {
    this.modulator.finished(index);
    this.manager.extractMembers(page, {}, this.memberNotifier);
  }

  private checkEnd() {
    if (this.cancled) return;
    if (this.inFlight == 0) {
      if (this.polling) {
        setTimeout(() => {
          if (this.cancled) return;

          this.notifier.pollCycle({}, {});
          const cl = this.cacheList.slice();
          this.cacheList = [];
          for (let cache of cl) {
            this.inFlight += 1;
            this.modulator.push(cache);
          }
        }, this.pollInterval || 1000);
      } else {
        log("Closing the notifier, polling is not set");
        this.cancled = true;
        this.notifier.close({}, {});
      }
    }
  }
}
