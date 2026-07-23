/**
 * Profile & minimums View (MCP Apps).
 *
 * Runs inside the host's sandboxed iframe. Renders the profile carried in
 * the `get_profile` / `update_profile` tool result (structuredContent) and
 * saves edits by calling the server's `update_profile` tool through the
 * host via `app.callServerTool`.
 *
 * Bundled to a single inline <script type="module"> by scripts/build-ui.mjs
 * using the SDK's prebuilt browser bundle ("app-with-deps").
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import { buildProfilePatch, MINIMUMS_FIELDS, type MinimumsKey } from "./profile-patch.js";

type MinimumsBlock = Record<MinimumsKey, number>;

interface ProfileView {
  /** Home airports, ICAO/FAA ids; index 0 is the primary field. */
  homeAirports: string[];
  aircraft: Array<{ tail: string; type: string; checkedOut: boolean }>;
  minimums: { day: MinimumsBlock; night: MinimumsBlock };
  preferences: { maxDistanceNm: number; budgetPerFlightUsd: number; typicalFlightKinds: string[] };
}

const form = document.getElementById("profile-form") as HTMLFormElement;
const statusEl = document.getElementById("status") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const aircraftListEl = document.getElementById("aircraft-list") as HTMLUListElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;

buildLimitInputs("day");
buildLimitInputs("night");

const app = new App({ name: "Runup Profile Form", version: "0.1.0" });

// Register every handler BEFORE connect() so no notification is missed.
app.ontoolinput = () => {
  subtitleEl.textContent = "Loading profile...";
};

app.ontoolresult = (result) => {
  const profile = result.structuredContent as ProfileView | undefined;
  if (profile && profile.minimums) {
    render(profile);
    setStatus("");
  } else {
    setStatus("Tool result did not include a profile.", "err");
  }
};

app.ontoolcancelled = (params) => {
  setStatus(`Cancelled: ${params.reason ?? "no reason given"}`, "err");
};

app.onhostcontextchanged = applyHostContext;
app.onteardown = async () => ({});
app.onerror = (err) => setStatus(String(err), "err");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveBtn.disabled = true;
  setStatus("Saving...");
  try {
    const result = await app.callServerTool({ name: "update_profile", arguments: { patch: collectPatch() } });
    if (result.isError) {
      setStatus(`Save failed: ${firstText(result) ?? "unknown error"}`, "err");
    } else {
      const updated = result.structuredContent as ProfileView | undefined;
      if (updated) render(updated);
      setStatus("Saved.", "ok");
    }
  } catch (err) {
    setStatus(`Save failed: ${(err as Error).message}`, "err");
  } finally {
    saveBtn.disabled = false;
  }
});

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});

// --- rendering / form helpers -----------------------------------------------------

function buildLimitInputs(block: "day" | "night"): void {
  const container = form.querySelector(`[data-block="${block}"]`) as HTMLElement;
  container.replaceChildren(
    ...MINIMUMS_FIELDS.map((f) => {
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      // Visibility takes fractional statute miles; knots and feet stay whole numbers.
      input.step = f.step;
      input.name = `minimums.${block}.${f.key}`;
      label.appendChild(input);
      return label;
    }),
  );
}

function render(profile: ProfileView): void {
  setValue("homeAirports", profile.homeAirports.join(", "));
  setValue("preferences.maxDistanceNm", profile.preferences.maxDistanceNm);
  setValue("preferences.budgetPerFlightUsd", profile.preferences.budgetPerFlightUsd);
  for (const block of ["day", "night"] as const) {
    for (const f of MINIMUMS_FIELDS) {
      setValue(`minimums.${block}.${f.key}`, profile.minimums[block][f.key]);
    }
  }
  const items = profile.aircraft.map((a) => `${a.tail} - ${a.type}${a.checkedOut ? "" : " (not checked out)"}`);
  aircraftListEl.replaceChildren(
    ...(items.length === 0 ? ["none in profile"] : items).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  subtitleEl.textContent = `Home ${profile.homeAirports.join(" / ")} - typical: ${profile.preferences.typicalFlightKinds.join(", ")}`;
}

/**
 * Form -> update_profile patch. Cleared numeric fields are omitted from the
 * patch (leave unchanged on the server) instead of being sent as 0.
 */
function collectPatch(): Record<string, unknown> {
  const data = new FormData(form);
  return buildProfilePatch((name) => {
    const value = data.get(name);
    return value === null ? null : String(value);
  });
}

function setValue(name: string, value: string | number): void {
  const input = form.elements.namedItem(name);
  if (input instanceof HTMLInputElement) input.value = String(value);
}

function setStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content?.find((c) => c.type === "text")?.text;
}

function applyHostContext(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${12 + top}px ${12 + right}px ${12 + bottom}px ${12 + left}px`;
  }
}
