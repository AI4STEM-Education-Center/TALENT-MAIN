"use client";
import { Mail } from "lucide-react";
import { SmtpSettings } from "./smtp-settings";
import { EmailSenders } from "./email-senders";
import { EmailLimits } from "./email-limits";

export default function AdminEmailPage() {
  return (
    <div className="p-4 md:p-6 space-y-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Mail className="size-6" /> Email / SMTP Server
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure the outgoing SMTP server used to deliver password resets and
          teacher and student emails, and choose the address each kind of email
          is sent from. In-app notifications are delivered without email and
          don&apos;t require SMTP.
        </p>
      </div>

      <SmtpSettings />
      <EmailSenders />
      <EmailLimits />
    </div>
  );
}
