import { Config } from "../config/config"
import { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import type { SessionID, MessageID } from "./schema"
import { Log } from "../util/log"
import { Session } from "."

export namespace FileSnapshot {
  const log = Log.create({ service: "file-snapshot" })

  export function isEnabled(
    snapshotConfig: boolean | "git" | "file" | undefined,
  ): boolean {
    return snapshotConfig === "file"
  }

  export async function isEnabledFromConfig(): Promise<boolean> {
    const config = await Config.get()
    return isEnabled(config.snapshot)
  }

  /**
   * Deduplicates by filePath within the same message
   * (MultiEditTool calls EditTool in a loop on the same file).
   */
  export async function capture(input: {
    sessionID: SessionID
    messageID: MessageID
    files: Array<{
      filePath: string
      beforeContent: string
      existed: boolean
    }>
  }) {
    if (!(await isEnabledFromConfig())) return
    if (input.files.length === 0) return

    const parts = await MessageV2.parts(input.messageID)
    const existingPaths = new Set<string>()
    for (const part of parts) {
      if (part.type === "file-snapshot") {
        for (const f of part.files) {
          existingPaths.add(f.filePath)
        }
      }
    }
    const newFiles = input.files.filter((f) => !existingPaths.has(f.filePath))
    if (newFiles.length === 0) return

    log.info("capturing file snapshots", {
      sessionID: input.sessionID,
      files: newFiles.map((f) => f.filePath),
    })

    await Session.updatePart({
      id: PartID.ascending(),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "file-snapshot",
      files: newFiles,
    })
  }
}
