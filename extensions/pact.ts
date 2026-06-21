import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_FRACTION = 0.8;
export const DEFAULT_THRESHOLD = { kind: "tokens", value: 160000 };

export function formatThreshold(threshold) {
	if (threshold.kind === "percent") return `${Math.round(threshold.value * 100)}%`;
	return threshold.value.toLocaleString();
}

export function parseFraction(value) {
	const fraction = Number(value);
	if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
		throw new Error("Fraction must be a number greater than 0 and at most 1");
	}
	return fraction;
}

export function parseThreshold(value) {
	const trimmed = String(value).trim();
	if (trimmed.endsWith("%")) {
		const percent = Number(trimmed.slice(0, -1));
		if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
			throw new Error("Threshold percent must be greater than 0 and less than 100");
		}
		return { kind: "percent", value: percent / 100 };
	}

	const tokens = Number(trimmed.replaceAll("_", ""));
	if (!Number.isInteger(tokens) || tokens <= 0) {
		throw new Error("Threshold must be a positive token count or percent like 60%");
	}
	return { kind: "tokens", value: tokens };
}

export function resolveThresholdTokens(threshold, contextWindow) {
	if (threshold.kind === "tokens") return threshold.value;
	return Math.floor(contextWindow * threshold.value);
}

function latestCompaction(entries) {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return { entry: entries[i], index: i };
	}
	return undefined;
}

export function boundaryStartIndex(entries) {
	const compaction = latestCompaction(entries);
	if (!compaction) return 0;

	const firstKeptIndex = entries.findIndex((entry) => entry.id === compaction.entry.firstKeptEntryId);
	return firstKeptIndex >= 0 ? firstKeptIndex : compaction.index + 1;
}

function isToolResultEntry(entry) {
	return entry.type === "message" && entry.message?.role === "toolResult";
}

export function toolResultCount(entries, startIndex = 0) {
	let count = 0;
	for (let i = startIndex; i < entries.length; i++) {
		if (isToolResultEntry(entries[i])) count++;
	}
	return count;
}

export function findPactCutIndex(entries, startIndex, fraction) {
	const toolResultIndices = [];
	for (let i = startIndex; i < entries.length; i++) {
		if (isToolResultEntry(entries[i])) toolResultIndices.push(i);
	}
	if (toolResultIndices.length < 2) return -1;

	const compactedToolResults = Math.max(1, Math.floor(toolResultIndices.length * fraction));
	let cutIndex = toolResultIndices[compactedToolResults - 1] + 1;
	while (cutIndex < entries.length && isToolResultEntry(entries[cutIndex])) {
		cutIndex++;
	}
	return cutIndex < entries.length ? cutIndex : -1;
}

function entryToMessage(entry) {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: Date.parse(entry.timestamp) || Date.now(),
		};
	}
	if (entry.type === "branch_summary") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: Date.parse(entry.timestamp) || Date.now(),
		};
	}
	return undefined;
}

export function messagesFromEntries(entries) {
	return entries.map(entryToMessage).filter((message) => message !== undefined);
}

export function collectFileOps(messages) {
	const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block?.type !== "toolCall") continue;
			const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
			if (!path) continue;
			if (block.name === "read") fileOps.read.add(path);
			if (block.name === "write") fileOps.written.add(path);
			if (block.name === "edit") fileOps.edited.add(path);
		}
	}
	return fileOps;
}

export function messageRole(message) {
	return message?.role ?? "unknown";
}

export function summarizeMessageOrder(messages, limit = 12) {
	return messages.slice(0, limit).map(messageRole).join(" → ");
}

export function verifyCompactionSummaryOrder(messages) {
	const summaryIndex = messages.findIndex((message) => messageRole(message) === "compactionSummary");
	if (summaryIndex < 0) {
		return { ok: true, summaryIndex, message: "No compaction summary in current context" };
	}
	if (summaryIndex !== 0) {
		return {
			ok: false,
			summaryIndex,
			message: `Compaction summary is at message ${summaryIndex + 1}, not first`,
		};
	}
	return {
		ok: true,
		summaryIndex,
		message: `Compaction summary is first; ${Math.max(0, messages.length - 1)} newer message(s) follow it`,
	};
}

export function buildPactPreparation(branchEntries, preparation, fraction) {
	const startIndex = boundaryStartIndex(branchEntries);
	const cutIndex = findPactCutIndex(branchEntries, startIndex, fraction);
	if (cutIndex <= startIndex) return undefined;

	const firstKeptEntry = branchEntries[cutIndex];
	if (!firstKeptEntry?.id) return undefined;

	const messagesToSummarize = messagesFromEntries(branchEntries.slice(startIndex, cutIndex));
	if (messagesToSummarize.length === 0) return undefined;

	return {
		...preparation,
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: false,
		fileOps: collectFileOps(messagesToSummarize),
	};
}


const PACT_STATS_ENTRY = "pact-stats";
const PACT_CONFIG_FILE = "pact.json";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pactStatsCount(entries: Array<{ type: string; customType?: string }>): number {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === PACT_STATS_ENTRY).length;
}

function defaultStartupSettings() {
	return {
		enabled: true,
		fraction: DEFAULT_FRACTION,
		threshold: DEFAULT_THRESHOLD,
		debugOrder: false,
		debugFile: undefined,
	};
}

function parseConfigBoolean(value, name) {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function parseEnvBoolean(value, name) {
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	throw new Error(`${name} must be 1, 0, true, or false`);
}

function parseDebugFile(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("debugFile must be a string or null");
	return value === "" ? undefined : value;
}

function readConfigFile(path) {
	if (!existsSync(path)) return {};

	let config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(errorMessage(error));
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("must contain a JSON object");
	}
	return config;
}

function applyPactConfig(settings, config) {
	if ("enabled" in config) settings.enabled = parseConfigBoolean(config.enabled, "enabled");
	if ("fraction" in config) settings.fraction = parseFraction(config.fraction);
	if ("threshold" in config) settings.threshold = parseThreshold(config.threshold);
	if ("debug" in config) settings.debugOrder = parseConfigBoolean(config.debug, "debug");
	if ("debugFile" in config) settings.debugFile = parseDebugFile(config.debugFile);
}

function applyEnvSettings(settings) {
	if (process.env.PACT_ENABLED) settings.enabled = parseEnvBoolean(process.env.PACT_ENABLED, "PACT_ENABLED");
	if (process.env.PACT_FRACTION) settings.fraction = parseFraction(process.env.PACT_FRACTION);
	if (process.env.PACT_THRESHOLD) settings.threshold = parseThreshold(process.env.PACT_THRESHOLD);
	if (process.env.PACT_DEBUG) settings.debugOrder = parseEnvBoolean(process.env.PACT_DEBUG, "PACT_DEBUG");
	if (process.env.PACT_DEBUG_FILE !== undefined) settings.debugFile = parseDebugFile(process.env.PACT_DEBUG_FILE);
}

async function pactConfigPaths(ctx) {
	const { CONFIG_DIR_NAME, getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const paths = [join(getAgentDir(), PACT_CONFIG_FILE)];
	if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, PACT_CONFIG_FILE));
	return paths;
}

async function readStartupSettings(ctx) {
	const settings = defaultStartupSettings();
	for (const path of await pactConfigPaths(ctx)) {
		try {
			applyPactConfig(settings, readConfigFile(path));
		} catch (error) {
			throw new Error(`${path}: ${errorMessage(error)}`);
		}
	}
	applyEnvSettings(settings);
	return settings;
}

function appendDebugRecord(path: string | undefined, record: Record<string, unknown>) {
	if (!path) return;
	appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let fraction = DEFAULT_FRACTION;
	let threshold = DEFAULT_THRESHOLD;
	let pactOnlyCompact = false;
	let pactProvidedCompaction = false;
	let pactCompactions = 0;
	let compacting = false;
	let debugOrder = false;
	let debugFile: string | undefined;
	let verifyNextContext = false;

	const setStatus = (ctx: ExtensionContext) => {
		const state = ctx.ui.theme.fg("accent", enabled ? "on" : "off");
		const settings = ctx.ui.theme.fg("muted", `${fraction} @ ${formatThreshold(threshold)} `);
		ctx.ui.setStatus("pact", ctx.ui.theme.fg("dim", "pact ") + (enabled ? settings : "") + state);
	};

	const canPact = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		const startIndex = boundaryStartIndex(branch);
		return toolResultCount(branch, startIndex) >= 2 && findPactCutIndex(branch, startIndex, fraction) > startIndex;
	};

	const triggerPact = (ctx: ExtensionContext, reason: string, continueAfterCompaction = false) => {
		if (!enabled || compacting || !canPact(ctx)) return;
		if (ctx.hasPendingMessages()) {
			appendDebugRecord(debugFile, { type: "compact_deferred", reason, pendingMessages: true });
			return;
		}
		compacting = true;
		pactOnlyCompact = true;
		appendDebugRecord(debugFile, { type: "compact_start", reason });
		ctx.ui.notify(`Pact compaction started (${reason})`, "info");
		ctx.compact({
			onComplete: () => {
				compacting = false;
				pactOnlyCompact = false;
				appendDebugRecord(debugFile, { type: "compact_complete", continueAfterCompaction });
				if (!continueAfterCompaction) return;
				setTimeout(() => {
					if (!ctx.isIdle() || ctx.hasPendingMessages()) {
						appendDebugRecord(debugFile, { type: "continue_skipped", reason: "pending_user_message" });
						return;
					}
					try {
						pi.sendMessage(
							{
								customType: "pact-continue",
								content: "Continue from the latest tool result.",
								display: false,
							},
							{ triggerTurn: true },
						);
					} catch (error) {
						appendDebugRecord(debugFile, { type: "continue_failed", error: errorMessage(error) });
					}
				}, 0);
			},
			onError: (error) => {
				compacting = false;
				pactOnlyCompact = false;
				appendDebugRecord(debugFile, { type: "compact_error", error: error.message });
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		let startup;
		try {
			startup = await readStartupSettings(ctx);
		} catch (error) {
			ctx.ui.notify(`Pact config error: ${errorMessage(error)}; using defaults`, "warning");
			startup = defaultStartupSettings();
		}
		enabled = startup.enabled;
		fraction = startup.fraction;
		threshold = startup.threshold;
		debugOrder = startup.debugOrder;
		debugFile = startup.debugFile;
		pactOnlyCompact = false;
		pactProvidedCompaction = false;
		pactCompactions = pactStatsCount(ctx.sessionManager.getEntries());
		compacting = false;
		setStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled || compacting) return;

		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		if (currentTokens === null) return;

		const thresholdTokens = resolveThresholdTokens(threshold, usage.contextWindow);
		if (currentTokens <= thresholdTokens) return;

		triggerPact(ctx, `${currentTokens.toLocaleString()} tokens`, event.toolResults.length > 0);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled || !pactOnlyCompact) return;

		const pactPreparation = buildPactPreparation(event.branchEntries, event.preparation, fraction);
		if (!pactPreparation) {
			if (pactOnlyCompact) {
				pactOnlyCompact = false;
				compacting = false;
				ctx.ui.notify("Pact skipped: not enough later messages to preserve", "warning");
				return { cancel: true };
			}
			return;
		}

		const model = ctx.model;
		if (!model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Pact auth failed: ${auth.error}`, "warning");
			return;
		}

		try {
			const { compact } = await import("@earendil-works/pi-coding-agent");
			const result = await compact(
				pactPreparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
			);
			pactOnlyCompact = false;
			pactProvidedCompaction = true;
			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted) ctx.ui.notify(`Pact compaction failed: ${errorMessage(error)}`, "error");
			if (pactOnlyCompact) {
				pactOnlyCompact = false;
				compacting = false;
				return { cancel: true };
			}
			return;
		}
	});

	pi.on("session_compact", async (event) => {
		appendDebugRecord(debugFile, {
			type: "session_compact",
			fromExtension: event.fromExtension,
			firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
		});
		if (pactProvidedCompaction) {
			pactCompactions++;
			verifyNextContext = true;
			try {
				pi.appendEntry(PACT_STATS_ENTRY, { count: pactCompactions });
			} catch (error) {
				appendDebugRecord(debugFile, { type: "stats_append_failed", error: errorMessage(error) });
			}
		}
		compacting = false;
		pactOnlyCompact = false;
		pactProvidedCompaction = false;
	});

	pi.on("context", async (event, ctx) => {
		if (!debugOrder && !debugFile && !verifyNextContext) return;

		const verification = verifyCompactionSummaryOrder(event.messages);
		const order = summarizeMessageOrder(event.messages);
		appendDebugRecord(debugFile, {
			type: "context_order",
			ok: verification.ok,
			summaryIndex: verification.summaryIndex,
			message: verification.message,
			order,
			messageCount: event.messages.length,
		});
		if (debugOrder && ctx.hasUI) {
			const level = verification.ok ? "info" : "warning";
			ctx.ui.notify(`Pact context order: ${verification.message}. First messages: ${order}`, level);
		}
		verifyNextContext = false;
	});

	pi.registerCommand("pact", {
		description: "Control early partial compaction: /pact, /pact on|off|toggle|status|stats|debug|verify|now|fraction N|threshold N",
		handler: async (args, ctx) => {
			const [action = "", value = ""] = args.trim().split(/\s+/, 2);
			try {
				if (action === "" || action === "now") {
					triggerPact(ctx, "manual");
				} else if (action === "on") {
					enabled = true;
				} else if (action === "off") {
					enabled = false;
				} else if (action === "toggle") {
					enabled = !enabled;
				} else if (action === "fraction") {
					fraction = parseFraction(value);
				} else if (action === "threshold") {
					threshold = parseThreshold(value);
				} else if (action === "stats") {
					const times = pactCompactions === 1 ? "time" : "times";
					ctx.ui.notify(`This session has been compacted through Pact ${pactCompactions} ${times}.`, "info");
					return;
				} else if (action === "debug") {
					debugOrder = value === "" ? !debugOrder : value === "on";
					ctx.ui.notify(`Pact context-order debug ${debugOrder ? "on" : "off"}`, "info");
					return;
				} else if (action === "verify") {
					const context = ctx.sessionManager.buildSessionContext();
					const verification = verifyCompactionSummaryOrder(context.messages);
					const order = summarizeMessageOrder(context.messages);
					ctx.ui.notify(`${verification.message}. First messages: ${order}`, verification.ok ? "info" : "warning");
					return;
				} else if (action !== "status") {
					ctx.ui.notify("Usage: /pact [on|off|toggle|status|stats|debug [on|off]|verify|now|fraction N|threshold N]", "warning");
					return;
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "warning");
				return;
			}

			setStatus(ctx);
			ctx.ui.notify(
				`Pact ${enabled ? "on" : "off"}; fraction ${fraction}; threshold ${formatThreshold(threshold)}`,
				"info",
			);
		},
	});
}
