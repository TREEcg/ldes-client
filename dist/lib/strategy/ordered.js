"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderedStrategy = void 0;
const heap_js_1 = require("heap-js");
const relation_1 = require("../relation");
const debug_1 = require("debug");
const _1 = require(".");
const log = (0, debug_1.default)("strategy");
class OrderedStrategy {
    members;
    manager;
    fetcher;
    // This can be T: controller or something
    notifier;
    // Contains a heap with all relations that have been launched
    // The heap will first handle unimportant relations,
    //   so when an important relation is handled, we can try to emit members
    //
    // With ordering ascending GT relations are important
    // With ordering descending LT relations are important
    launchedRelations;
    modulator;
    fetchNotifier;
    memberNotifer;
    fetchedPages;
    state;
    ordered;
    polling;
    toPoll;
    pollInterval;
    cancled = false;
    constructor(memberManager, fetcher, notifier, factory, ordered, polling, pollInterval) {
        const logger = log.extend("constructor");
        this.ordered = ordered;
        this.manager = memberManager;
        this.fetcher = fetcher;
        this.notifier = notifier;
        this.polling = polling;
        this.pollInterval = pollInterval;
        this.toPoll = new heap_js_1.default((a, b) => a.chain.ordering(b.chain));
        this.launchedRelations = new heap_js_1.default((a, b) => a.ordering(b));
        this.fetchedPages = new heap_js_1.default((a, b) => a.relation.ordering(b.relation));
        this.state = [];
        // Callbacks for the fetcher
        // - seen: the strategy wanted to fetch an uri, but it was already seen
        //         so one fetch request is terminated, inFlight -= 1, and remove it from the launchedRelations
        // - pageFetched: a complete page is fetched and the relations have been extracted
        //         start member extraction
        // - relationFound: a relation has been found, put the extended chain in the queue
        this.fetchNotifier = {
            scheduleFetch: ({ target, expected }, { chain }) => {
                chain.target = target;
                this.toPoll.push({ chain, expected });
            },
            pageFetched: (page, { chain, index }) => {
                logger("Page fetched %s", page.url);
                this.modulator.finished(index);
                this.handleFetched(page, chain);
            },
            relationFound: ({ from, target }, { chain }) => {
                from.expected.push(target.node);
                logger("Relation found %s", target.node);
                const newChain = chain.push(target.node, this.extractRelation(target));
                if (newChain.ordering(chain) >= 0) {
                    this.fetch(newChain, [from.target]);
                }
                else {
                    console.error("Found relation backwards in time, this indicates wrong tree structure. Ignoring");
                }
            },
        };
        // Callbacks for member manager
        // - done: extracting is done, indicate this
        // - extract: a member is extracted, add it to our heap
        this.memberNotifer = {
            done: (_member, rel) => {
                logger("Member done %s", rel.target);
                const found = this.findOrDefault(rel);
                found.extracting -= 1;
                this.notifier.fragment({}, {});
                this.checkEmit();
            },
            extracted: (member) => {
                this.members.push(member);
            },
        };
        this.modulator = factory.create("fetcher", new heap_js_1.default((a, b) => a.item.chain.ordering(b.item.chain)), {
            ready: ({ item: { chain, expected }, index }) => {
                this.fetcher.fetch({ target: chain.target, expected }, { chain, index }, this.fetchNotifier);
            },
        }, (inp) => {
            const { chain, expected } = inp;
            const cmp = this.ordered === "ascending"
                ? (a, b) => {
                    if (a > b)
                        return 1;
                    if (a < b)
                        return -1;
                    return 0;
                }
                : (a, b) => {
                    if (a > b)
                        return -1;
                    if (a < b)
                        return 1;
                    return 0;
                };
            return {
                chain: new relation_1.RelationChain(chain.source, chain.target, chain.relations, undefined, cmp),
                expected,
            };
        });
        if (ordered == "ascending") {
            this.members = new heap_js_1.default((a, b) => {
                if (a.id.equals(b.id))
                    return 0;
                if (a.timestamp < b.timestamp)
                    return -1;
                if (a.timestamp > b.timestamp)
                    return 1;
                if (a.isLastOfTransaction && !b.isLastOfTransaction)
                    return 1;
                if (!a.isLastOfTransaction && b.isLastOfTransaction)
                    return -1;
                if (a.timestamp == b.timestamp)
                    return 0;
                if (!a && b)
                    return 1;
                if (a && !b)
                    return -1;
                return 1;
            });
        }
        else {
            this.members = new heap_js_1.default((a, b) => {
                if (a.id.equals(b.id))
                    return 0;
                if (a.timestamp < b.timestamp)
                    return 1;
                if (a.timestamp > b.timestamp)
                    return -1;
                if (a.isLastOfTransaction && !b.isLastOfTransaction)
                    return -1;
                if (!a.isLastOfTransaction && b.isLastOfTransaction)
                    return 1;
                if (a.timestamp == b.timestamp)
                    return 0;
                if (!a && b)
                    return -1;
                if (a && !b)
                    return 1;
                return -1;
            });
        }
    }
    start(url) {
        const logger = log.extend("start");
        logger("Starting at %s", url);
        const cmp = (a, b) => {
            if (a > b)
                return 1;
            if (a < b)
                return -1;
            return 0;
        };
        if (this.ordered === "ascending") {
            this.fetch(new relation_1.RelationChain("", url, [], undefined, (a, b) => cmp(a, b)).push(url, {
                important: false,
                value: 0,
            }), []);
        }
        else {
            this.fetch(new relation_1.RelationChain("", url, [], undefined, (a, b) => -1 * cmp(a, b)).push(url, { important: false, value: 0 }), []);
        }
    }
    cancle() {
        this.cancled = true;
    }
    findOrDefault(chain) {
        const out = this.state.find((x) => x.rel.ordering(chain) == 0);
        if (out) {
            return out;
        }
        const nel = { rel: chain, inFlight: 0, extracting: 0, closed: false };
        this.state.push(nel);
        return nel;
    }
    /**
     * Extracting basic information from the relation, according to the current configuration
     * Sorting in ascending order: if a relation comes in with a LT relation, then that relation important, because it can be handled later
     * Sorting in descending order: if a relation comes in with a GT relation, then that relation important, because it can be handled later
     */
    extractRelation(rel) {
        const val = (s) => {
            try {
                return new Date(s);
            }
            catch (ex) {
                return s;
            }
        };
        if (this.ordered === "ascending" && _1.GTRs.some((x) => rel.type.equals(x))) {
            return {
                important: true,
                // Maybe this should create a date
                value: val(rel.value[0].value),
            };
        }
        else if (this.ordered === "descending" &&
            _1.LTR.some((x) => rel.type.equals(x))) {
            return {
                important: true,
                // Maybe this should create a date
                value: val(rel.value[0].value),
            };
        }
        else {
            return {
                important: false,
                value: 0,
            };
        }
    }
    fetch(rel, expected) {
        this.launchedRelations.push(rel);
        this.findOrDefault(rel).inFlight += 1;
        this.modulator.push({ chain: rel, expected });
    }
    handleFetched(page, relation) {
        this.fetchedPages.push({ page, relation });
        // Update internal state
        // Page is fetched and will now be extracted
        const found = this.findOrDefault(relation);
        found.extracting += 1;
        found.inFlight -= 1;
        this.manager.extractMembers(page, relation, this.memberNotifer);
    }
    /**
     * Maybe we can emit a member
     * Only the case when our current relation is important
     */
    checkEmit() {
        let head = this.launchedRelations.pop();
        while (head) {
            const marker = head.relations[0] || { value: 0, important: false };
            const found = this.findOrDefault(head);
            // If this relation still has things in transit, or getting extracted, we must wait
            if (found.inFlight != 0 || found.extracting != 0) {
                break;
            }
            // Actually emit some members in order
            if (marker.important) {
                found.closed = true;
                let member = this.members.pop();
                while (member) {
                    // Euhm yeah, what to do if there is no timestamp?
                    if (!member.timestamp) {
                        this.notifier.member(member, {});
                    }
                    else if (this.ordered == "ascending"
                        ? member.timestamp < marker.value
                        : member.timestamp > marker.value) {
                        this.notifier.member(member, {});
                    }
                    else {
                        break;
                    }
                    member = this.members.pop();
                }
                // This member failed, let's put him back
                if (member) {
                    this.members.push(member);
                }
            }
            head = this.launchedRelations.pop();
        }
        if (head) {
            this.launchedRelations.push(head);
        }
        this.checkEnd();
    }
    checkEnd() {
        if (this.cancled)
            return;
        const logger = log.extend("checkEnd");
        // There are no relations more to be had, emit the other members
        if (this.launchedRelations.isEmpty()) {
            logger("No more launched relations");
            let member = this.members.pop();
            while (member) {
                this.notifier.member(member, {});
                member = this.members.pop();
            }
            if (this.polling) {
                logger("Polling is enabled, settings timeout");
                setTimeout(() => {
                    if (this.cancled)
                        return;
                    this.notifier.pollCycle({}, {});
                    const toPollArray = this.toPoll.toArray();
                    logger("Let's repoll (%o)", toPollArray.map((x) => x.chain.target));
                    this.toPoll.clear();
                    for (let rel of toPollArray) {
                        this.launchedRelations.push(rel.chain);
                        this.findOrDefault(rel.chain).inFlight += 1;
                        this.findOrDefault(rel.chain).closed = false;
                        this.modulator.push(rel);
                    }
                }, this.pollInterval || 1000);
            }
            else {
                logger("Closing the notifier, polling is not set");
                this.cancled = true;
                this.notifier.close({}, {});
            }
        }
    }
}
exports.OrderedStrategy = OrderedStrategy;
