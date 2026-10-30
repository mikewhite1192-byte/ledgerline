import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The models page's "How the models score" card: the recorded eval run, one row per model the
// agent's own calls were sent to, the agreement line, the planted-instruction lines and Muse Spark
// Open's own numbers. Plain words in, no reads. The page renders it only when its switch is on
// and a run is recorded.

export type EvalCardRow = {
  label: string;
  modelId: string | null;
  scored: string;
  rightAnswer: string;
  rightAmount: string;
  rightFix: string;
  seconds: string;
  cents: string;
  centsInAll: string;
};

export type EvalCardProps = {
  rows: readonly EvalCardRow[];
  agreement: string;
  planted: readonly string[];
  openWeights: readonly string[];
  stoppedAtCap: boolean;
};

const COLUMNS = ["Model", "Cases scored", "Right answer", "Right amount", "Right fix", "Seconds per case", "Cents per case", "Cents in all"] as const;

export function EvalCard({ rows, agreement, planted, openWeights, stoppedAtCap }: EvalCardProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>How the models score</CardTitle>
          <CardDescription>
            The same planted pay, invoice and payment problems, worked by each model on a fresh copy of the sample carriers.
            The second check runs on Muse Wonder in every row. Scored by fixed rules, never by a model.
          </CardDescription>
        </div>
      </CardHeader>
      <CardBody className="grid gap-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-small">
            <thead>
              <tr className="border-b border-border">
                {COLUMNS.map((c) => (
                  <th key={c} scope="col" className="py-2 pr-3 font-medium text-foreground-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row" className="py-2 pr-3 font-medium text-foreground">
                    {r.label}
                    {r.modelId ? <span className="block font-mono text-caption text-muted-foreground">{r.modelId}</span> : null}
                  </th>
                  {[r.scored, r.rightAnswer, r.rightAmount, r.rightFix, r.seconds, r.cents, r.centsInAll].map((v, i) => (
                    <td key={COLUMNS[i + 1]} className="py-2 pr-3 tabular-nums text-foreground">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-small text-foreground-2">{agreement}</p>
        {planted.length > 0 ? (
          <ul className="grid gap-1 text-small text-foreground-2">
            {planted.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {openWeights.length > 0 ? (
          <ul className="grid gap-1 text-small text-foreground-2">
            {openWeights.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {stoppedAtCap ? (
          <p className="text-small text-foreground-2">The run stopped at its own spending limit; the cases it did not reach are not scored.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
