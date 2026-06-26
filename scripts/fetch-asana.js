// Pulls task status from an Asana project and writes it to data.json,
// which index.html reads to render the public tracker page.
//
// Required environment variables:
//   ASANA_TOKEN        Asana Personal Access Token (set as a GitHub secret —
//                       never commit this or put it in the HTML).
//   ASANA_PROJECT_GID  The Asana project ID to track.
// Optional:
//   TRACKER_TITLE       Overrides the title shown on the page.

const fs = require('node:fs/promises');

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const PROJECT_GID = process.env.ASANA_PROJECT_GID;
const TRACKER_TITLE =
  process.env.TRACKER_TITLE || 'ZEKA — Packaging timeline & payment tracker';

if (!ASANA_TOKEN || !PROJECT_GID) {
  console.error('Missing ASANA_TOKEN or ASANA_PROJECT_GID environment variable.');
  process.exit(1);
}

const API_BASE = 'https://app.asana.com/api/1.0';

async function asanaGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana API error ${res.status} on ${path}: ${body}`);
  }
  const json = await res.json();
  return json.data;
}

// "Phase 1 — รับ Brief & Dieline (29 มิ.ย. – 3 ก.ค. 69)"
//   -> { title: "Phase 1 — รับ Brief & Dieline", dateRange: "29 มิ.ย. – 3 ก.ค. 69" }
function splitSectionName(name) {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { title: m[1].trim(), dateRange: m[2].trim() };
  return { title: name.trim(), dateRange: null };
}

function phaseStatus(total, completed) {
  if (total === 0) return 'not_started';
  if (completed === total) return 'completed';
  if (completed > 0) return 'in_progress';
  return 'not_started';
}

// Payment installments are written in Asana as their own tasks, e.g.
//   "💳 เรียกเก็บงวดที่ 2 (30%) - หลัง Sign-off กลุ่ม 1"
// Detecting and parsing them here means the payment schedule on the
// tracker always matches Asana exactly — including whether the
// installment task has been checked off — with nothing to keep in
// sync by hand. Only the percentage and condition text are read;
// no currency amounts are ever pulled or shown.
const PAYMENT_RE = /งวดที่\s*(\d+)\s*\((\d+)%\)\s*-\s*(.+)$/;

function parsePaymentTask(task) {
  const match = task.name.match(PAYMENT_RE);
  if (!match) return null;
  return {
    installment: Number(match[1]),
    percent: Number(match[2]),
    condition: match[3].trim(),
    due_on: task.due_on,
    completed: task.completed,
  };
}

async function main() {
  const sections = await asanaGet(
    `/projects/${PROJECT_GID}/sections?opt_fields=name&limit=100`
  );

  const phases = [];
  const paymentMilestones = [];
  let totalTasks = 0;
  let totalCompleted = 0;

  for (const section of sections) {
    const tasks = await asanaGet(
      `/sections/${section.gid}/tasks?opt_fields=name,completed,due_on&limit=100`
    );

    if (tasks.length === 0) continue; // skip empty/leftover sections

    const normalTasks = [];
    for (const task of tasks) {
      const milestone = parsePaymentTask(task);
      if (milestone) {
        paymentMilestones.push(milestone);
      } else {
        normalTasks.push(task);
      }
    }

    if (normalTasks.length === 0) continue;

    const completedCount = normalTasks.filter((t) => t.completed).length;
    const { title, dateRange } = splitSectionName(section.name);

    phases.push({
      name: title,
      date_range: dateRange,
      total_tasks: normalTasks.length,
      completed_tasks: completedCount,
      status: phaseStatus(normalTasks.length, completedCount),
      tasks: normalTasks.map((t) => ({
        name: t.name,
        completed: t.completed,
        due_on: t.due_on,
      })),
    });

    totalTasks += normalTasks.length;
    totalCompleted += completedCount;
  }

  // Highlight the first phase that isn't fully done as "current",
  // so the page can show clients where the project actually stands today.
  let currentMarked = false;
  for (const phase of phases) {
    if (!currentMarked && phase.status !== 'completed') {
      phase.is_current = true;
      currentMarked = true;
    } else {
      phase.is_current = false;
    }
  }

  paymentMilestones.sort((a, b) => a.installment - b.installment);

  const data = {
    project_name: TRACKER_TITLE,
    last_updated: new Date().toISOString(),
    summary: {
      total_tasks: totalTasks,
      completed_tasks: totalCompleted,
      remaining_tasks: totalTasks - totalCompleted,
      percent_complete:
        totalTasks === 0 ? 0 : Math.round((totalCompleted / totalTasks) * 100),
    },
    phases,
    payment_milestones: paymentMilestones,
  };

  await fs.writeFile('data.json', JSON.stringify(data, null, 2));
  console.log(
    `Wrote data.json — ${totalCompleted}/${totalTasks} tasks complete across ${phases.length} phases, ${paymentMilestones.length} payment milestones.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
