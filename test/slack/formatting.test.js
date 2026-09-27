import test from "node:test";
import assert from "node:assert/strict";
import { markdownMessages } from "../../src/slack/formatting.js";

test("Markdown preservation", () => {
    const text = "# Heading\n\n**Bold** and [source](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    assert.deepEqual(markdownMessages(text), [text]);
});

test("code boundaries", () => {
    const text = "```js\n" + "const value = 1;\n".repeat(1000) + "```";
    const messages = markdownMessages(text);
    assert.ok(messages.length > 1);
    for (const message of messages) {
        assert.ok(message.startsWith("```js\n"));
        assert.ok(message.trimEnd().endsWith("```"));
        assert.ok(message.length <= 12000);
    }
});

test("mention safety", () => {
    const text = "@here <@U123> <!channel>\n```text\n@here <@U123>\n```";
    const [message] = markdownMessages(text);
    assert.ok(message.startsWith("@\u200bhere &lt;@U123&gt; &lt;!channel&gt;"));
    assert.ok(message.includes("```text\n@here <@U123>\n```"));
});

test("Unicode boundaries", () => {
    const messages = markdownMessages("🙂".repeat(9000));
    assert.equal(messages.join(""), "🙂".repeat(9000));
    assert.ok(messages.every((message) => message.isWellFormed() && message.length <= 12000));
});

test("unfinished code", () => {
    assert.equal(markdownMessages("```sh\necho ok")[0], "```sh\necho ok\n```");
});

test("long code line", () => {
    const messages = markdownMessages("```js\n" + "x".repeat(10838) + "\n```");
    assert.ok(messages.length > 1);
    assert.ok(messages.every((message) => message.length <= 12000));
});

test("ordinary words", () => {
    assert.deepEqual(markdownMessages("task-id ask-for-help sk-test-secret"), ["task-id ask-for-help [REDACTED]"]);
});
