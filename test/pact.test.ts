import test from "node:test";
import assert from "node:assert/strict";

import registerPactExtension, {
	DEFAULT_THRESHOLD,
	buildPactPreparation,
	boundaryStartIndex,
	findPactCutIndex,
	formatPercentAmount,
	formatThreshold,
	parseFraction,
	parseThreshold,
	resolveThresholdTokens,
	summarizeMessageOrder,
	toolResultCount,
	verifyCompactionSummaryOrder,
} from "../extensions/pact.ts";

const entry = (id, message) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-05-28T00:00:00.000Z",
	message,
});

const user = (id) => entry(id, { role: "user", content: "do work", timestamp: 1 });
const assistant = (id, toolName = "read", path = `/tmp/${id}`) =>
	entry(id, {
		role: "assistant",
		content: [{ type: "toolCall", id: `${id}-tool`, name: toolName, arguments: { path } }],
		timestamp: 1,
	});
const tool = (id) => entry(id, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "result" }], timestamp: 1 });
const compactionSummary = () => ({ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: 1 });

test("findPactCutIndex cuts after the configured early fraction of tool results", () => {
	const entries = [
		user("u1"),
		assistant("a1"),
		tool("t1"),
		user("u2"),
		assistant("a2"),
		tool("t2"),
		user("u3"),
		assistant("a3"),
		tool("t3"),
		user("u4"),
	];

	assert.equal(toolResultCount(entries), 3);
	assert.equal(findPactCutIndex(entries, 0, 0.5), 3);
	assert.equal(entries[3].id, "u2");
});

test("findPactCutIndex does not preserve orphaned adjacent tool results", () => {
	const entries = [
		user("u1"),
		assistant("a1"),
		tool("t1"),
		tool("t2"),
		user("u2"),
		assistant("a2"),
		tool("t3"),
	];

	assert.equal(findPactCutIndex(entries, 0, 0.5), 4);
	assert.equal(entries[4].id, "u2");
});

test("buildPactPreparation rewrites first kept entry and summarized messages", () => {
	const entries = [
		user("u1"),
		assistant("a1", "read", "/tmp/one"),
		tool("t1"),
		user("u2"),
		assistant("a2", "edit", "/tmp/two"),
		tool("t2"),
		user("u3"),
	];
	const base = {
		firstKeptEntryId: "u3",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
	};

	const prep = buildPactPreparation(entries, base, 0.5);

	assert.equal(prep.firstKeptEntryId, "u2");
	assert.equal(prep.messagesToSummarize.length, 3);
	assert.deepEqual([...prep.fileOps.read], ["/tmp/one"]);
	assert.deepEqual([...prep.fileOps.edited], []);
});

test("buildPactPreparation summarizes only earlier messages and keeps later messages", () => {
	const entries = [user("u1"), assistant("a1"), tool("t1"), assistant("a2"), tool("t2")];
	const base = {
		firstKeptEntryId: "t2",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
	};

	const prep = buildPactPreparation(entries, base, 0.5);
	const firstKeptIndex = entries.findIndex((entry) => entry.id === prep.firstKeptEntryId);

	assert.equal(prep.firstKeptEntryId, "a2");
	assert.deepEqual(prep.messagesToSummarize.map((message) => message.role), ["user", "assistant", "toolResult"]);
	assert.deepEqual(entries.slice(firstKeptIndex).map((entry) => entry.id), ["a2", "t2"]);
});

test("appended compaction summarizes the prefix while newer messages remain after the summary", () => {
	const entries = [user("u1"), assistant("a1"), tool("t1"), assistant("a2"), tool("t2")];
	const base = {
		firstKeptEntryId: "t2",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
	};

	const prep = buildPactPreparation(entries, base, 0.5);
	const sessionEntries = [
		...entries,
		{ type: "compaction", id: "c1", parentId: "t2", summary: "summary", firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: 123 },
	];
	const firstKeptIndex = sessionEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
	const contextRoles = ["compactionSummary", ...sessionEntries.slice(firstKeptIndex, -1).map((entry) => entry.message.role)];

	assert.deepEqual(prep.messagesToSummarize.map((message) => message.role), ["user", "assistant", "toolResult"]);
	assert.deepEqual(contextRoles, ["compactionSummary", "assistant", "toolResult"]);
	assert.equal(sessionEntries.at(-1).type, "compaction");
});

test("boundaryStartIndex starts at previous compaction first kept entry", () => {
	const entries = [
		user("u1"),
		{ type: "compaction", id: "c1", parentId: null, timestamp: "2026-05-28T00:00:00.000Z", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 100 },
		user("u2"),
		assistant("a2"),
		tool("t2"),
	];

	assert.equal(boundaryStartIndex(entries), 2);
});

test("parse settings validates and formats percent amounts and thresholds", () => {
	assert.equal(parseFraction("0.25"), 0.25);
	assert.equal(parseFraction("80%"), 0.8);
	assert.equal(formatPercentAmount(0.8), "80%");
	assert.throws(() => parseFraction("2"), /at most 1/);
	assert.deepEqual(DEFAULT_THRESHOLD, { kind: "percent", value: 0.6 });
	assert.deepEqual(parseThreshold("125_000"), { kind: "tokens", value: 125000 });
	assert.deepEqual(parseThreshold("60%"), { kind: "percent", value: 0.6 });
	assert.equal(formatThreshold({ kind: "tokens", value: 125000 }), "125,000");
	assert.equal(formatThreshold({ kind: "percent", value: 0.6 }), "60%");
	assert.equal(resolveThresholdTokens({ kind: "percent", value: 0.6 }, 200000), 120000);
});

test("verifyCompactionSummaryOrder confirms newer messages follow the summary", () => {
	const messages = [compactionSummary(), { role: "user", content: "newer" }, { role: "assistant", content: [] }];
	const verification = verifyCompactionSummaryOrder(messages);

	assert.equal(verification.ok, true);
	assert.match(verification.message, /2 newer message/);
	assert.equal(summarizeMessageOrder(messages), "compactionSummary → user → assistant");
});

test("verifyCompactionSummaryOrder warns when the summary is not first", () => {
	const verification = verifyCompactionSummaryOrder([{ role: "user", content: "newer" }, compactionSummary()]);

	assert.equal(verification.ok, false);
	assert.match(verification.message, /not first/);
});

test("registers /pact as manual trigger and management commands with colon names", () => {
	const commands = new Map();
	const pi = {
		on() {},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};

	registerPactExtension(pi);

	assert.deepEqual([...commands.keys()].sort(), [
		"pact",
		"pact:debug",
		"pact:fraction",
		"pact:off",
		"pact:on",
		"pact:stats",
		"pact:status",
		"pact:threshold",
		"pact:toggle",
		"pact:verify",
	].sort());
	assert.match(commands.get("pact").description, /Manually trigger/);
	assert.match(commands.get("pact:stats").description, /stats/i);
});

