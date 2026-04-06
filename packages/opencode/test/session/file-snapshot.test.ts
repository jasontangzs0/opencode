import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { FileSnapshot } from "../../src/session/file-snapshot"
import { Session } from "../../src/session"
import { SessionRevert } from "../../src/session/revert"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(
  sessionID: SessionID,
  parentID: MessageID,
  cwd: string,
): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd, root: cwd },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
}

async function makeUserMsg(sessionID: SessionID) {
  return Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "default",
    model: {
      providerID: ProviderID.make("openai"),
      modelID: ModelID.make("gpt-4"),
    },
    time: { created: Date.now() },
  })
}

async function addTextPart(sessionID: SessionID, messageID: MessageID, text: string) {
  await Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
  })
}

async function addFileSnapshot(
  sessionID: SessionID,
  messageID: MessageID,
  files: Array<{ filePath: string; beforeContent: string; existed: boolean }>,
) {
  await Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "file-snapshot",
    files,
  })
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)
}

// ---------------------------------------------------------------------------
// Tests: isEnabled
// ---------------------------------------------------------------------------

describe("FileSnapshot", () => {
  describe("isEnabled", () => {
    test("returns true when config snapshot is 'file'", () => {
      expect(FileSnapshot.isEnabled("file")).toBe(true)
    })

    test("returns false when config snapshot is true", () => {
      expect(FileSnapshot.isEnabled(true)).toBe(false)
    })

    test("returns false when config snapshot is 'git'", () => {
      expect(FileSnapshot.isEnabled("git")).toBe(false)
    })

    test("returns false when config snapshot is false", () => {
      expect(FileSnapshot.isEnabled(false)).toBe(false)
    })

    test("returns false when config snapshot is undefined", () => {
      expect(FileSnapshot.isEnabled(undefined)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Tests: basic revert
  // -------------------------------------------------------------------------

  describe("revert", () => {
    test("restores a single edited file to its before-content", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "test.txt")
          await fs.writeFile(filePath, "original content")

          const session = await Session.create({})
          const sid = session.id

          const userMsg = await makeUserMsg(sid)
          await addTextPart(sid, userMsg.id, "edit my file")

          const aMsg = makeAssistantMsg(sid, userMsg.id, tmp.path)
          await Session.updateMessage(aMsg)
          await addFileSnapshot(sid, aMsg.id, [
            { filePath, beforeContent: "original content", existed: true },
          ])
          await fs.writeFile(filePath, "modified content")

          expect(await fs.readFile(filePath, "utf-8")).toBe("modified content")

          await SessionRevert.revert({ sessionID: sid, messageID: userMsg.id })

          expect(await fs.readFile(filePath, "utf-8")).toBe("original content")
          await Session.remove(sid)
        },
      })
    })

    test("deletes a file that was created by the agent", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "new-file.txt")

          const session = await Session.create({})
          const sid = session.id

          const userMsg = await makeUserMsg(sid)
          await addTextPart(sid, userMsg.id, "create a file")

          const aMsg = makeAssistantMsg(sid, userMsg.id, tmp.path)
          await Session.updateMessage(aMsg)
          await addFileSnapshot(sid, aMsg.id, [
            { filePath, beforeContent: "", existed: false },
          ])
          await fs.writeFile(filePath, "new file content")

          expect(await fileExists(filePath)).toBe(true)

          await SessionRevert.revert({ sessionID: sid, messageID: userMsg.id })

          expect(await fileExists(filePath)).toBe(false)
          await Session.remove(sid)
        },
      })
    })

    test("multiple edits to same file reverts to the earliest before-content", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "multi.txt")
          await fs.writeFile(filePath, "version A")

          const session = await Session.create({})
          const sid = session.id

          // Turn 1: A -> B
          const u1 = await makeUserMsg(sid)
          await addTextPart(sid, u1.id, "first edit")
          const a1 = makeAssistantMsg(sid, u1.id, tmp.path)
          await Session.updateMessage(a1)
          await addFileSnapshot(sid, a1.id, [
            { filePath, beforeContent: "version A", existed: true },
          ])
          await fs.writeFile(filePath, "version B")

          // Turn 2: B -> C
          const u2 = await makeUserMsg(sid)
          await addTextPart(sid, u2.id, "second edit")
          const a2 = makeAssistantMsg(sid, u2.id, tmp.path)
          await Session.updateMessage(a2)
          await addFileSnapshot(sid, a2.id, [
            { filePath, beforeContent: "version B", existed: true },
          ])
          await fs.writeFile(filePath, "version C")

          expect(await fs.readFile(filePath, "utf-8")).toBe("version C")

          await SessionRevert.revert({ sessionID: sid, messageID: u1.id })

          expect(await fs.readFile(filePath, "utf-8")).toBe("version A")
          await Session.remove(sid)
        },
      })
    })

    test("reverts multiple files from a single tool call (apply_patch)", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const fileA = path.join(tmp.path, "a.txt")
          const fileB = path.join(tmp.path, "b.txt")
          const fileC = path.join(tmp.path, "c.txt")
          await fs.writeFile(fileA, "aaa")
          await fs.writeFile(fileB, "bbb")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "patch files")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath: fileA, beforeContent: "aaa", existed: true },
            { filePath: fileB, beforeContent: "bbb", existed: true },
            { filePath: fileC, beforeContent: "", existed: false },
          ])
          await fs.writeFile(fileA, "AAA")
          await fs.writeFile(fileB, "BBB")
          await fs.writeFile(fileC, "CCC")

          await SessionRevert.revert({ sessionID: sid, messageID: u.id })

          expect(await fs.readFile(fileA, "utf-8")).toBe("aaa")
          expect(await fs.readFile(fileB, "utf-8")).toBe("bbb")
          expect(await fileExists(fileC)).toBe(false)
          await Session.remove(sid)
        },
      })
    })

    test("restores an empty file correctly", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "empty.txt")
          await fs.writeFile(filePath, "")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "edit empty file")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "", existed: true },
          ])
          await fs.writeFile(filePath, "no longer empty")

          await SessionRevert.revert({ sessionID: sid, messageID: u.id })

          expect(await fs.readFile(filePath, "utf-8")).toBe("")
          expect(await fileExists(filePath)).toBe(true)
          await Session.remove(sid)
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Tests: unrevert (redo)
  // -------------------------------------------------------------------------

  describe("unrevert", () => {
    test("restores files to post-edit state after revert", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "redo.txt")
          await fs.writeFile(filePath, "before")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "edit")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "before", existed: true },
          ])
          await fs.writeFile(filePath, "after")

          // Revert
          await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          expect(await fs.readFile(filePath, "utf-8")).toBe("before")

          // Unrevert (redo)
          await SessionRevert.unrevert({ sessionID: sid })
          expect(await fs.readFile(filePath, "utf-8")).toBe("after")

          await Session.remove(sid)
        },
      })
    })

    test("unrevert re-creates a file that was deleted by revert", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "created.txt")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "create file")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "", existed: false },
          ])
          await fs.writeFile(filePath, "created content")

          // Revert -> file deleted
          await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          expect(await fileExists(filePath)).toBe(false)

          // Unrevert -> file restored
          await SessionRevert.unrevert({ sessionID: sid })
          expect(await fs.readFile(filePath, "utf-8")).toBe("created content")

          await Session.remove(sid)
        },
      })
    })

    test("unrevert clears the revert state", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "state.txt")
          await fs.writeFile(filePath, "original")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "edit")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "original", existed: true },
          ])
          await fs.writeFile(filePath, "changed")

          await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          let info = await Session.get(sid)
          expect(info.revert).toBeDefined()
          expect(info.revert?.fileContents).toBeDefined()

          await SessionRevert.unrevert({ sessionID: sid })
          info = await Session.get(sid)
          expect(info.revert).toBeUndefined()

          await Session.remove(sid)
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Tests: cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    test("deletes messages after the revert point", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "cleanup.txt")
          await fs.writeFile(filePath, "original")

          const session = await Session.create({})
          const sid = session.id

          const u1 = await makeUserMsg(sid)
          await addTextPart(sid, u1.id, "first")
          const a1 = makeAssistantMsg(sid, u1.id, tmp.path)
          await Session.updateMessage(a1)
          await addTextPart(sid, a1.id, "response 1")

          const u2 = await makeUserMsg(sid)
          await addTextPart(sid, u2.id, "second")
          const a2 = makeAssistantMsg(sid, u2.id, tmp.path)
          await Session.updateMessage(a2)
          await addFileSnapshot(sid, a2.id, [
            { filePath, beforeContent: "original", existed: true },
          ])
          await fs.writeFile(filePath, "modified")

          // 4 messages before revert
          let msgs = await Session.messages({ sessionID: sid })
          expect(msgs.length).toBe(4)

          await SessionRevert.revert({ sessionID: sid, messageID: u2.id })

          // Messages still present (marked for revert, not deleted yet)
          msgs = await Session.messages({ sessionID: sid })
          expect(msgs.length).toBe(4)

          // Cleanup finalizes the revert
          const info = await Session.get(sid)
          await SessionRevert.cleanup(info)

          msgs = await Session.messages({ sessionID: sid })
          expect(msgs.length).toBeLessThan(4)
          const ids = msgs.map((m) => m.info.id)
          expect(ids).not.toContain(u2.id)
          expect(ids).not.toContain(a2.id)

          const infoAfter = await Session.get(sid)
          expect(infoAfter.revert).toBeUndefined()

          await Session.remove(sid)
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // Tests: edge cases from audit
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("revert with no file-snapshot parts returns session unchanged", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "hello")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addTextPart(sid, a.id, "hi there")

          // No file-snapshot parts at all — simulates git->file mode switch
          const result = await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          // Should return without setting revert state
          expect(result.revert).toBeUndefined()

          await Session.remove(sid)
        },
      })
    })

    test("unrevert dispatches on stored state, not current config", async () => {
      // Simulates: revert in file mode (fileContents stored),
      // then unrevert is called — should use fileContents regardless of current config
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "mode-switch.txt")
          await fs.writeFile(filePath, "original")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "edit")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "original", existed: true },
          ])
          await fs.writeFile(filePath, "modified")

          // Revert stores fileContents
          await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          expect(await fs.readFile(filePath, "utf-8")).toBe("original")

          const info = await Session.get(sid)
          expect(info.revert?.fileContents).toBeDefined()
          expect(info.revert?.fileContents?.length).toBe(1)
          expect(info.revert?.snapshot).toBeUndefined()

          // Unrevert should use fileContents (the stored data)
          await SessionRevert.unrevert({ sessionID: sid })
          expect(await fs.readFile(filePath, "utf-8")).toBe("modified")

          await Session.remove(sid)
        },
      })
    })

    test("revert with already-deleted file does not throw", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "ghost.txt")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "create and delete")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "", existed: false },
          ])
          // Agent created the file, then something else deleted it before revert
          // (file doesn't exist on disk)

          // Should not throw
          await SessionRevert.revert({ sessionID: sid, messageID: u.id })
          expect(await fileExists(filePath)).toBe(false)

          await Session.remove(sid)
        },
      })
    })

    test("partial revert to second turn preserves first turn's changes", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const fileA = path.join(tmp.path, "a.txt")
          const fileB = path.join(tmp.path, "b.txt")
          await fs.writeFile(fileA, "original A")
          await fs.writeFile(fileB, "original B")

          const session = await Session.create({})
          const sid = session.id

          // Turn 1: edit fileA
          const u1 = await makeUserMsg(sid)
          await addTextPart(sid, u1.id, "edit A")
          const a1 = makeAssistantMsg(sid, u1.id, tmp.path)
          await Session.updateMessage(a1)
          await addFileSnapshot(sid, a1.id, [
            { filePath: fileA, beforeContent: "original A", existed: true },
          ])
          await fs.writeFile(fileA, "modified A")

          // Turn 2: edit fileB
          const u2 = await makeUserMsg(sid)
          await addTextPart(sid, u2.id, "edit B")
          const a2 = makeAssistantMsg(sid, u2.id, tmp.path)
          await Session.updateMessage(a2)
          await addFileSnapshot(sid, a2.id, [
            { filePath: fileB, beforeContent: "original B", existed: true },
          ])
          await fs.writeFile(fileB, "modified B")

          // Revert only turn 2 — fileA should stay modified, fileB restored
          await SessionRevert.revert({ sessionID: sid, messageID: u2.id })

          expect(await fs.readFile(fileA, "utf-8")).toBe("modified A")
          expect(await fs.readFile(fileB, "utf-8")).toBe("original B")

          await Session.remove(sid)
        },
      })
    })

    test("revert sets session revert state with fileContents", async () => {
      await using tmp = await tmpdir({ git: true, config: { snapshot: "file" } })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filePath = path.join(tmp.path, "state-check.txt")
          await fs.writeFile(filePath, "before")

          const session = await Session.create({})
          const sid = session.id

          const u = await makeUserMsg(sid)
          await addTextPart(sid, u.id, "edit")
          const a = makeAssistantMsg(sid, u.id, tmp.path)
          await Session.updateMessage(a)
          await addFileSnapshot(sid, a.id, [
            { filePath, beforeContent: "before", existed: true },
          ])
          await fs.writeFile(filePath, "after")

          await SessionRevert.revert({ sessionID: sid, messageID: u.id })

          const info = await Session.get(sid)
          expect(info.revert).toBeDefined()
          expect(info.revert!.fileContents).toBeDefined()
          expect(info.revert!.fileContents!.length).toBe(1)
          expect(info.revert!.fileContents![0].filePath).toBe(filePath)
          // fileContents stores the CURRENT (post-edit) content for redo
          expect(info.revert!.fileContents![0].content).toBe("after")
          expect(info.revert!.fileContents![0].exists).toBe(true)
          // snapshot should NOT be set in file mode
          expect(info.revert!.snapshot).toBeUndefined()

          await Session.remove(sid)
        },
      })
    })
  })
})
