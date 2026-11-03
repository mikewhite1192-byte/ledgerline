import { HomeCard, Nothing, Unavailable } from "@/components/home/home-card";
import type { Loaded } from "@/lib/home/loaded";
import type { FeedLine } from "@/lib/feed/words";
import { FeedList } from "./feed-list";

// Home's small window on the live feed: its newest few lines and the way to the whole page. A read
// that failed says so, never reads as a quiet day.
export function FeedCard({ feed }: { feed: Loaded<FeedLine[]> }) {
  return (
    <HomeCard title="Live feed" link={{ href: "/activity", label: "Open the live feed" }}>
      {!feed.ok ? (
        <Unavailable>Could not read the feed. Nothing changed.</Unavailable>
      ) : feed.value.length === 0 ? (
        <Nothing>Each step the agent, the desk, the autopilot and people take with money shows here.</Nothing>
      ) : (
        <FeedList lines={feed.value} />
      )}
    </HomeCard>
  );
}
