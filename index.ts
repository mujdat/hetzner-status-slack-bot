import { mkdir } from "node:fs/promises";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const LANG = (process.env.HETZNER_STATUS_LANG || "en") as "en" | "de";
const parsedInterval = Number(process.env.POLL_INTERVAL_SECONDS);
const POLL_INTERVAL =
  (Number.isFinite(parsedInterval) && parsedInterval >= 30 ? parsedInterval : 300) * 1000;
const STATE_FILE = process.env.STATE_FILE_PATH || "./state.json";
const STATUS_URL = `https://status.hetzner.com/${LANG}`;
const DEBUG_COUNT = Number(process.env.DEBUG_POST_LAST) || 0;
const STATE_MAX_AGE_DAYS = Number(process.env.STATE_MAX_AGE_DAYS) || 30;

if (!SLACK_WEBHOOK_URL) {
  console.error("SLACK_WEBHOOK_URL is required");
  process.exit(1);
}

interface IncidentUpdate {
  id: number;
  descriptionDe: string;
  descriptionEn: string;
  createdAt: string;
  incidentState: string;
  updatedAt: string;
  visible: boolean;
}

interface Incident {
  id: number;
  uuid: string;
  system: string;
  titleEn: string;
  titleDe: string;
  descriptionEn: string;
  descriptionDe: string;
  incidentState: string;
  incidentType: string;
  startTime: string;
  endTime: string | null;
  createdAt: string;
  updatedAt: string;
  incidentUpdates: IncidentUpdate[];
}

interface HetznerSystem {
  id: number;
  titleEn: string;
  titleDe: string;
}

interface PageData {
  systems: HetznerSystem[];
  incidents: {
    topNotification: Incident[];
    informationList: Incident[];
    maintenanceList: Incident[];
    incidentHistory: Incident[];
  };
}

interface StoredState {
  [incidentId: string]: {
    updatedAt: string;
    updateCount: number;
  };
}

async function loadState(): Promise<StoredState> {
  try {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
  } catch {
    // First run or corrupt state - Start fresh
  }
  return {};
}

async function saveState(state: StoredState): Promise<void> {
  const dir = STATE_FILE.substring(0, STATE_FILE.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchStatusPage(): Promise<PageData> {
  const response = await fetch(STATUS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch status page: ${response.status}`);
  }

  const html = await response.text();

  // Extract __NEXT_DATA__ JSON from the page
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!match?.[1]) {
    throw new Error("Could not find __NEXT_DATA__ in status page");
  }

  const nextData = JSON.parse(match[1]);
  const pageProps = nextData.props?.pageProps;

  if (!pageProps?.incidents) {
    throw new Error("Unexpected page structure - no incidents found");
  }

  return {
    systems: pageProps.systems || [],
    incidents: {
      topNotification: pageProps.incidents.topNotification || [],
      informationList: pageProps.incidents.informationList || [],
      maintenanceList: pageProps.incidents.maintenanceList || [],
      incidentHistory: pageProps.incidents.incidentHistory || [],
    },
  };
}

const TYPE_EMOJI: Record<string, string> = {
  outage: "\u{1F6A8}",
  maintenance: "\u{1F527}",
  warning: "\u{26A0}\u{FE0F}",
  other: "\u{2139}\u{FE0F}",
};

const STATE_EMOJI: Record<string, string> = {
  scheduled: "\u{1F4C5}",
  identified: "\u{1F50D}",
  in_progress: "\u{23F3}",
  update: "\u{1F504}",
  resolved: "\u{2705}",
  monitoring: "\u{1F4CA}",
};

function title(incident: Incident): string {
  return LANG === "de" ? incident.titleDe : incident.titleEn;
}

function description(incident: Incident): string {
  return LANG === "de" ? incident.descriptionDe : incident.descriptionEn;
}

function updateDescription(update: IncidentUpdate): string {
  return LANG === "de" ? update.descriptionDe : update.descriptionEn;
}

function buildSystemLookup(systems: HetznerSystem[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const sys of systems) {
    const name = LANG === "de" ? sys.titleDe : sys.titleEn;
    lookup.set(`/systems/${sys.id}`, name);
  }
  return lookup;
}

function formatIncidentMessage(
  incident: Incident,
  category: string,
  systemName: string,
  isUpdate: boolean,
): object {
  const typeEmoji = TYPE_EMOJI[incident.incidentType] || "\u{2139}\u{FE0F}";
  const stateEmoji = STATE_EMOJI[incident.incidentState] || "\u{25AA}\u{FE0F}";
  const headerText = isUpdate ? "Status Update" : "New Incident";
  const headerContent = `${typeEmoji} ${headerText}: ${title(incident)}`;

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headerContent.substring(0, 150),
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Type:* ${incident.incidentType}` },
        { type: "mrkdwn", text: `*State:* ${stateEmoji} ${incident.incidentState}` },
        { type: "mrkdwn", text: `*System:* ${systemName}` },
        { type: "mrkdwn", text: `*Category:* ${category}` },
      ],
    },
  ];

  // Add description if present
  const desc = description(incident);
  if (desc) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: desc.substring(0, 3000) },
    });
  }

  // Add latest updates (up to 3, sorted chronologically)
  const visibleUpdates = incident.incidentUpdates
    .filter((u) => u.visible)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-3);

  if (visibleUpdates.length > 0) {
    blocks.push({ type: "divider" });
    for (const update of visibleUpdates) {
      const updateText = updateDescription(update);
      if (updateText) {
        const updateStateEmoji = STATE_EMOJI[update.incidentState] || "\u{25AA}\u{FE0F}";
        const time = new Date(update.createdAt).toLocaleString();
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${updateStateEmoji} *${update.incidentState}* (${time})\n${updateText.substring(0, 2000)}`,
          },
        });
      }
    }
  }

  // Add link to specific incident page
  const incidentUrl = `${STATUS_URL}/incident/${incident.uuid}`;
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${incidentUrl}|View Details> | <${STATUS_URL}|Hetzner Status Page>`,
      },
    ],
  });

  return { blocks };
}

async function postToSlack(message: object): Promise<void> {
  const response = await fetch(SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook failed: ${response.status} - ${text}`);
  }
}

function getAllIncidents(data: PageData): { incident: Incident; category: string }[] {
  const results: { incident: Incident; category: string }[] = [];

  for (const inc of data.incidents.topNotification) {
    results.push({ incident: inc, category: "Top Notification" });
  }
  for (const inc of data.incidents.informationList) {
    results.push({ incident: inc, category: "Information" });
  }
  for (const inc of data.incidents.maintenanceList) {
    results.push({ incident: inc, category: "Maintenance" });
  }
  for (const inc of data.incidents.incidentHistory) {
    results.push({ incident: inc, category: "Incident" });
  }

  return results;
}

async function checkAndNotify(state: StoredState): Promise<StoredState> {
  const data = await fetchStatusPage();
  const systemLookup = buildSystemLookup(data.systems);
  const allIncidents = getAllIncidents(data);
  // Preserve previous state so incidents that temporarily drop off the page aren't re-notified
  const newState: StoredState = { ...state };
  const currentIds = new Set<string>();
  let notified = 0;

  for (const { incident, category } of allIncidents) {
    const key = String(incident.id);
    const updateCount = incident.incidentUpdates.length;
    const prev = state[key];

    currentIds.add(key);
    newState[key] = {
      updatedAt: incident.updatedAt,
      updateCount,
    };

    // Check if this is new or updated
    const isNew = !prev;
    const isUpdated =
      prev && (prev.updatedAt !== incident.updatedAt || prev.updateCount !== updateCount);

    if (isNew || isUpdated) {
      const systemName = systemLookup.get(incident.system) || "Unknown";
      const message = formatIncidentMessage(incident, category, systemName, !isNew);

      try {
        // Delay between messages to avoid Slack rate limiting
        if (notified > 0) {
          await Bun.sleep(1000);
        }
        await postToSlack(message);
        notified++;
      } catch (err) {
        console.error(`Failed to post incident ${incident.id} to Slack:`, err);
      }
    }
  }

  if (notified > 0) {
    console.log(`[${new Date().toISOString()}] Posted ${notified} update(s) to Slack`);
  }

  // Prune entries that are no longer on the status page and are older than STATE_MAX_AGE_DAYS
  const cutoff = Date.now() - STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [key, entry] of Object.entries(newState)) {
    if (!currentIds.has(key) && new Date(entry.updatedAt).getTime() < cutoff) {
      delete newState[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[${new Date().toISOString()}] Pruned ${pruned} stale state entries`);
  }

  return newState;
}

async function main() {
  console.log("Hetzner Status Slack Bot starting...");
  console.log(`  Language: ${LANG}`);
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`  Status URL: ${STATUS_URL}`);
  console.log(`  State file: ${STATE_FILE}`);

  // Debug mode: post the first N incidents (active ones first) and exit
  if (DEBUG_COUNT > 0) {
    console.log(`DEBUG MODE: posting ${DEBUG_COUNT} incidents to Slack...`);
    const data = await fetchStatusPage();
    const systemLookup = buildSystemLookup(data.systems);
    const allIncidents = getAllIncidents(data).slice(0, DEBUG_COUNT);

    for (let i = 0; i < allIncidents.length; i++) {
      const { incident, category } = allIncidents[i];
      const systemName = systemLookup.get(incident.system) || "Unknown";
      const message = formatIncidentMessage(incident, category, systemName, false);
      if (i > 0) await Bun.sleep(1000);
      await postToSlack(message);
      console.log(`  [${category}] ${title(incident)}`);
    }

    console.log("DEBUG MODE: done.");
    process.exit(0);
  }

  let state = await loadState();
  const isFirstRun = Object.keys(state).length === 0;

  if (isFirstRun) {
    // On first run, load current state without notifying
    // This prevents spamming the channel with all existing incidents
    console.log("First run - loading current state without notifications...");
    const data = await fetchStatusPage();
    const allIncidents = getAllIncidents(data);

    for (const { incident } of allIncidents) {
      state[String(incident.id)] = {
        updatedAt: incident.updatedAt,
        updateCount: incident.incidentUpdates.length,
      };
    }

    await saveState(state);
    console.log(
      `Loaded ${Object.keys(state).length} existing incidents. Will notify on changes from now on.`,
    );

    // Post a startup message to Slack
    try {
      await postToSlack({
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `\u{2705} *Hetzner Status Bot started*\nTracking ${Object.keys(state).length} incidents from <${STATUS_URL}|status.hetzner.com>.\nYou'll be notified of new incidents and updates.`,
            },
          },
        ],
      });
    } catch (err) {
      console.error("Failed to post startup message to Slack:", err);
    }
  }

  // Poll loop
  while (true) {
    await Bun.sleep(POLL_INTERVAL);

    try {
      state = await checkAndNotify(state);
      await saveState(state);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error during check:`, err);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
