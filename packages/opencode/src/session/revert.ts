import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { Database, eq } from "../storage/db"
import { MessageTable, PartTable } from "./session.sql"
import { Storage } from "@/storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"
import { FileSnapshot } from "./file-snapshot"
import { Filesystem } from "../util/filesystem"
import { diffLines } from "diff"
import * as fs from "fs/promises"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  function findRevertPoint(
    all: MessageV2.WithParts[],
    input: RevertInput,
  ): Session.Info["revert"] | undefined {
    let lastUser: MessageV2.User | undefined
    let result: Session.Info["revert"] | undefined
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining: MessageV2.Part[] = []
      for (const part of msg.parts) {
        if (result) continue
        if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
          const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
          result = {
            messageID: !partID && lastUser ? lastUser.id : msg.info.id,
            partID,
          }
        }
        remaining.push(part)
      }
    }
    return result
  }

  export async function revert(input: RevertInput) {
    if (await FileSnapshot.isEnabledFromConfig()) {
      return revertFileSnapshots(input)
    }
    SessionPrompt.assertNotBusy(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      const session = await Session.get(input.sessionID)
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      await Snapshot.revert(patches)
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
      const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
      const diffs = await SessionSummary.computeDiff({ messages: rangeMessages })
      await Storage.write(["session_diff", input.sessionID], diffs)
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      return Session.setRevert({
        sessionID: input.sessionID,
        revert,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
    }
    return session
  }

  async function revertFileSnapshots(input: RevertInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    const session = await Session.get(input.sessionID)

    const revertPoint = findRevertPoint(all, input)
    if (!revertPoint) return session

    // Keep only the first beforeContent per filePath (the true original)
    const fileSnapshots: Array<{ filePath: string; beforeContent: string; existed: boolean }> = []
    const seen = new Set<string>()
    for (const msg of all) {
      if (msg.info.id < revertPoint.messageID) continue
      for (const part of msg.parts) {
        if (part.type !== "file-snapshot") continue
        for (const f of part.files) {
          if (seen.has(f.filePath)) continue
          seen.add(f.filePath)
          fileSnapshots.push(f)
        }
      }
    }

    // If no file-snapshot parts found (session started in git mode), nothing to revert
    if (fileSnapshots.length === 0) {
      log.warn("no file-snapshot parts found, session may have used git snapshot mode")
      return session
    }

    const currentContents = await Promise.all(
      fileSnapshots.map(async (snap) => {
        const exists = await Filesystem.exists(snap.filePath)
        const content = exists ? await Filesystem.readText(snap.filePath) : ""
        const status: "added" | "deleted" | "modified" = !snap.existed
          ? "added"
          : !exists
            ? "deleted"
            : "modified"
        let additions = 0
        let deletions = 0
        for (const change of diffLines(snap.beforeContent, content)) {
          if (change.added) additions += change.count || 0
          if (change.removed) deletions += change.count || 0
        }
        return {
          filePath: snap.filePath,
          content,
          exists,
          status,
          additions,
          deletions,
        }
      }),
    )

    await Promise.all(
      fileSnapshots.map((snap) =>
        snap.existed
          ? Filesystem.write(snap.filePath, snap.beforeContent)
          : fs.unlink(snap.filePath).catch(() => {}),
      ),
    )

    const rangeMessages = all.filter((msg) => msg.info.id >= revertPoint!.messageID)
    const diffs = await SessionSummary.computeDiff({ messages: rangeMessages })
    await Storage.write(["session_diff", input.sessionID], diffs)
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })

    revertPoint.fileContents = currentContents
    return Session.setRevert({
      sessionID: input.sessionID,
      revert: revertPoint,
      summary: {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      },
    })
  }

  export async function unrevert(input: { sessionID: SessionID }) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session

    // Dispatch based on what the revert state contains, not current config
    // (user may have switched modes between revert and unrevert)
    if (session.revert.fileContents) {
      await Promise.all(
        session.revert.fileContents.map((entry) =>
          entry.exists
            ? Filesystem.write(entry.filePath, entry.content)
            : fs.unlink(entry.filePath).catch(() => {}),
        ),
      )
    } else if (session.revert.snapshot) {
      await Snapshot.restore(session.revert.snapshot)
    }
    return Session.clearRevert(input.sessionID)
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    const msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        remove.push(msg)
        continue
      }
      if (session.revert.partID) {
        preserve.push(msg)
        target = msg
        continue
      }
      remove.push(msg)
    }
    for (const msg of remove) {
      Database.use((db) => db.delete(MessageTable).where(eq(MessageTable.id, msg.info.id)).run())
      await Bus.publish(MessageV2.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        for (const part of removeParts) {
          Database.use((db) => db.delete(PartTable).where(eq(PartTable.id, part.id)).run())
          await Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    await Session.clearRevert(sessionID)
  }
}
