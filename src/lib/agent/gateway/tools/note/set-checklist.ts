import { checklistArgs } from "../../../checklist";
import { CHECKLIST_TOOL } from "../../../policy";
import { defineTool } from "../../types";
import { OPERATOR } from "../shared";

// The answer's checklist (design-agents-101 3.1). It reads nothing and writes nothing: the list
// comes back on the result, and the operator loop stores it on the turn and shows it, the way a
// propose tool's draft is kept by the loop, so the gateway itself stays free of writes. A second
// call replaces the whole list; a tick is the same call with one state changed. Always on: it
// touches nothing outside the app.

export const setChecklist = defineTool({
  name: CHECKLIST_TOOL,
  description:
    "Show the person a short checklist of what you will do for this answer, and tick it as you " +
    "go. Send the whole list every time: 2 to 6 short items in the person's words, each with a " +
    "state (todo, doing, done or skipped). Call it again beside the tool calls of every later " +
    "response, with the items those calls are for set to doing; never alone and never with your " +
    "final answer. A later call replaces the list. It reads and changes nothing.",
  tier: "read",
  roles: OPERATOR,
  label: "Made a checklist",
  args: checklistArgs,
  refs: () => [],
  run: async (_q, _ctx, a) => ({
    result: { set: true, itemCount: a.items.length },
    checklist: { items: a.items.map((i) => ({ text: i.text, state: i.state ?? "todo" })) },
  }),
});
