import { getModel } from "@factor/post/database"
import {
  randomToken,
  emitEvent,
  applyFilters,
  addCallback,
  currentUrl
} from "@factor/tools"
import { hasEmailService, sendTransactional } from "@factor/email/server"
import { getSetting } from "@factor/plugin-email-list"
import * as endpoints from "@factor/plugin-email-list/server"
import { Model, Document, Query } from "mongoose"
import { EmailConfig } from "./types"

type StandardQuery = Promise<Query<Document>>

const uniqueId = (listId: string): string => {
  return `_plugin-emailList-${listId}`
}

const postModel = (): Model<Document> => {
  return getModel("emailList")
}

// https://stackoverflow.com/questions/33576223/using-mongoose-mongodb-addtoset-functionality-on-array-of-objects
export const addEmail = async ({
  email,
  listId = "default",
  tags = []
}: EmailConfig): Promise<void> => {
  // Allow for external services to hook in
  email = applyFilters(`plugin-email-list-add-${listId}`, email)

  const code = randomToken()

  // Ensure that the post exists
  // Can't do all this in one query or it prevents detection of dupes / create unique index problems
  await postModel().updateOne(
    { uniqueId: uniqueId(listId) },
    { title: listId },
    { upsert: true }
  )

  const result = await postModel().updateOne(
    { uniqueId: uniqueId(listId), "list.email": { $ne: email } },
    { $addToSet: { list: { email, verified: false, code, tags } } }
  )

  // If email already exists, update it with new code
  if (result.nModified == 0) {
    await postModel().updateOne(
      { uniqueId: uniqueId(listId), "list.email": email },
      { $set: { "list.$.code": code } }
    )
  }

  if (hasEmailService()) {
    await sendConfirmEmail({ email, listId, code })
  }

  emitEvent("email-list-new-email-added", { email, listId, tags })

  return
}

export const deleteEmails = async ({
  emails,
  listId = "default"
}: {
  emails: string[];
  listId: string;
}): StandardQuery => {
  // query resource: https://stackoverflow.com/a/48933447/1858322
  const result = await postModel().updateOne(
    { uniqueId: uniqueId(listId) },
    { $pull: { list: { email: { $in: emails } } } }
  )

  return result
}

const sendCompleteEmail = async ({ email, listId }: EmailConfig): Promise<void> => {
  const format = getSetting({ key: "emails.complete", listId })

  if (!format) return

  const { subject, text, from } = format

  return await sendTransactional({
    to: email,
    subject,
    text,
    from
  })
}

const sendNotifyEmail = async ({ email, listId }: EmailConfig): Promise<void> => {
  const format = getSetting({ key: "emails.notify", listId })

  if (!format) return

  const { subject, text, to, from } = format

  if (to) {
    await sendTransactional({
      to,
      subject,
      text: text + `<p><strong>Email:</strong> ${email}</p>`,
      from
    })
  }

  return
}

// Positional Operator
// https://docs.mongodb.com/manual/reference/operator/update/positional/?_ga=1.12567092.1864968360.1429722620#up._S_
export const verifyEmail = async ({
  email,
  list: listId = "default",
  code
}: EmailConfig): StandardQuery => {
  const result = await postModel().updateOne(
    { uniqueId: uniqueId(listId), "list.code": code, "list.email": email },
    { $set: { "list.$.verified": true, "list.$.code": null } }
  )

  if (result && result.nModified > 0) {
    await Promise.all([
      sendNotifyEmail({ email, listId }),
      sendCompleteEmail({ email, listId })
    ])
  }
  return result
}

const sendConfirmEmail = async ({ email, listId, code }: EmailConfig): Promise<void> => {
  const action = `verify-email-list`

  const format = getSetting({
    key: "emails.confirm",
    listId
  })

  if (!format) {
    return await sendCompleteEmail({ email, listId })
  }

  const { subject, text, from, linkText } = format

  const linkUrl = `${currentUrl()}?_action=${action}&code=${code}&email=${encodeURIComponent(
    email
  )}&list=${listId}`

  return await sendTransactional({
    to: email,
    from,
    subject,
    text,
    linkText,
    linkUrl
  })
}

export const setup = (): void => {
  addCallback("endpoints", { id: "emailList", handler: endpoints })
}

setup()