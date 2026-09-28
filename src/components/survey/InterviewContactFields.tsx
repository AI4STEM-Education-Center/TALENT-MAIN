"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INTERVIEW_CONTACT_COPY } from "@/lib/survey";
import type { InterviewChoice } from "./SurveyFormView";

export type InterviewContactState = InterviewChoice & {
  editing: boolean;
  confirmed: boolean;
};

export function InterviewContactFields({
  formId,
  interview,
  setInterview,
}: {
  formId: string;
  interview: InterviewContactState;
  setInterview: Dispatch<SetStateAction<InterviewContactState>>;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border bg-muted/40 p-4">
      <legend className="px-1 text-base font-semibold">
        {INTERVIEW_CONTACT_COPY.heading}
      </legend>
      <p className="text-sm text-muted-foreground">
        {INTERVIEW_CONTACT_COPY.body}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={interview.optIn}
          onChange={(e) =>
            setInterview((prev) => ({ ...prev, optIn: e.target.checked }))
          }
        />
        <span>{INTERVIEW_CONTACT_COPY.checkbox}</span>
      </label>
      {interview.optIn && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            Confirm the email we should use for post-survey and interview
            messages.
          </p>
          {interview.editing ? (
            <div className="space-y-1">
              <label
                htmlFor={`survey-${formId}-interview-email`}
                className="text-sm font-medium"
              >
                {INTERVIEW_CONTACT_COPY.emailLabel}
              </label>
              <Input
                id={`survey-${formId}-interview-email`}
                type="email"
                autoComplete="email"
                className="max-w-sm"
                value={interview.email}
                maxLength={254}
                onChange={(e) =>
                  setInterview((prev) => ({
                    ...prev,
                    email: e.target.value,
                    confirmed: false,
                  }))
                }
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="break-all text-sm">{interview.email}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setInterview((prev) => ({
                    ...prev,
                    editing: true,
                    confirmed: false,
                  }))
                }
              >
                Change email
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This email is only for post-survey and interview messages. Your
            login email will stay the same.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={interview.confirmed}
              onChange={(e) =>
                setInterview((prev) => ({
                  ...prev,
                  confirmed: e.target.checked,
                }))
              }
            />
            <span>Use this email for post-survey and interview messages.</span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
