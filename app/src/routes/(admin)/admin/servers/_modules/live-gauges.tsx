import type React from "react";

import { Progress } from "@/components/ui/progress";
import type { LiveMetricSample } from "@/lib/live-metrics";
import { formatUsage, usagePercent } from "@/lib/server-live-state";
import { m } from "@/paraglide/messages";

const environmentLabel = {
  systemd: m.server_live_environment_systemd,
  docker: m.server_live_environment_docker,
  containerd: m.server_live_environment_containerd,
  kubernetes: m.server_live_environment_kubernetes,
  container: m.server_live_environment_container,
  unknown: m.server_live_environment_unknown,
};

const scopeLabel = {
  host: m.server_live_scope_host,
  container: m.server_live_scope_container,
};

/** CPU, memory and disk as one bordered strip of label/value pairs. */
export function LiveGauges({
  sample,
}: {
  sample: LiveMetricSample;
}): React.ReactElement {
  const gauges = [
    {
      label: m.server_live_cpu(),
      value: sample.cpuPercent,
      display:
        sample.cpuPercent === null
          ? m.server_live_missing()
          : `${sample.cpuPercent.toFixed(1)}%`,
    },
    {
      label: m.server_live_memory(),
      value: usagePercent(sample.memoryUsedBytes, sample.memoryTotalBytes),
      display: formatUsage(
        sample.memoryUsedBytes,
        sample.memoryTotalBytes,
        (used, total) => m.server_live_usage({ used, total }),
        m.server_live_missing(),
      ),
    },
    {
      label: m.server_live_disk(),
      value: usagePercent(sample.diskUsedBytes, sample.diskTotalBytes),
      display: formatUsage(
        sample.diskUsedBytes,
        sample.diskTotalBytes,
        (used, total) => m.server_live_usage({ used, total }),
        m.server_live_missing(),
      ),
    },
  ];

  return (
    <section
      data-slot="live-gauges"
      aria-label={m.admin_server_ws_gauges_label()}
      className="grid divide-y border-y md:grid-cols-3 md:divide-x md:divide-y-0"
    >
      {gauges.map(({ label, value, display }) => (
        <div key={label} className="flex flex-col gap-1.5 px-4 py-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-sm font-medium tabular-nums">{display}</span>
          {value === null ? null : (
            <Progress aria-label={label} value={Math.min(100, value)} />
          )}
        </div>
      ))}
    </section>
  );
}

export function LiveEnvironment({
  sample,
}: {
  sample: LiveMetricSample;
}): React.ReactElement {
  return (
    <p className="text-xs text-muted-foreground">
      {environmentLabel[sample.environment]()} · {scopeLabel[sample.scope]()}
    </p>
  );
}
