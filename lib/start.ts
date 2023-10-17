import { replicateLDES } from "./client";
import { intoConfig } from "./config";

async function main() {
  const client = replicateLDES(
    intoConfig({
      url: "http://era.ilabt.imec.be/ldes/onType/root",
      fetcher: { maxFetched: 2, concurrentRequests: 10 },
    }),
    // intoConfig({ url: "http://marineregions.org/feed" }),
  );

  const reader = client.stream({ highWaterMark: 10 }).getReader();
  let el = await reader.read();
  const seen = new Set();
  while (el) {
    if (el.value) {
      seen.add(el.value.id);
      console.log(
        "Got member",
        // el.value.id.value,
        el.value.quads.length,
        "quads",
        seen.size,
      );
    }

    if (el.done) break;

    // await new Promise((res) => setTimeout(res, 100));

    el = await reader.read();
  }
}

main().catch(console.error);