import { writeFileSync } from "node:fs";

export default async function* integrationReporter(source) {
  const reportPath = process.env.ARTIFLOW_INTEGRATION_SKIP_REPORT;
  const skipped = [];
  for await (const event of source) {
    if (event.type !== "test:pass" || !event.data?.skip) continue;
    const reason = event.data.skip === true ? "skipped" : String(event.data.skip);
    skipped.push({
      name: event.data.name ?? "(unnamed)",
      file: event.data.file ?? "",
      reason,
    });
  }
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ skipped }), { mode: 0o600 });
  }
  yield "";
}
