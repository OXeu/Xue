/**
 * shared/types.ts — 跨模块共享的类型定义
 *
 * ListenEntry 是 listen 落盘和 agent 消费的统一类型。
 * 图片仅以 phash[] 标识，不保留 URL 或原始图片数据。
 */

export interface ListenEntry {
  /** 会话标识: group_{id} 或 private_{id} */
  session: string;
  /** 消息 ID */
  msgId: number;
  /** 时间戳（秒） */
  time: number;
  /** 消息类型: text / at / image / reply / mixed / … */
  type: string;
  /** 纯文本内容（strip 掉所有 CQ 码后的正文） */
  text: string;
  /** 发送者 QQ */
  userId: number;
  /** 发送者昵称 */
  nickname: string;
  /** 发送者群名片（如有） */
  card?: string;
  /** 发送者群角色（owner / admin / member） */
  senderRole?: string;
  /** 消息子类型 */
  subType: string;
  /** 收到此消息的 bot QQ */
  selfId: number;
  /** @ 了哪些 QQ（数组） */
  atUsers: number[];
  /** 是否 @全体成员 */
  atAll?: boolean;
  /** 回复引用的消息 ID（如有） */
  replyTo?: number;
  /** 原始消息段类型分布（脱敏摘要） */
  segmentTypes?: string[];
  /** 图片 pHash 值列表（listen 下载完成后填充） */
  phash?: string[];
}

/** ProcessedEvent — listen 产出、agent 消费的处理后事件通知。与 ListenEntry 同形。 */
export type ProcessedEvent = ListenEntry;
