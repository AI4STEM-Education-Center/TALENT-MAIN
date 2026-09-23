// Read-only rendering of an extracted syllabus, shared by the teacher's review
// page and the student page. Hook-free, so it renders as a server component on
// the student page and inside the teacher's client panel alike.

import {
  CalendarDays,
  GraduationCap,
  Info,
  ListChecks,
  Mail,
  Scale,
  ScrollText,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SYLLABUS_EVENT_LABELS,
  addDays,
  eventsBetween,
  formatIsoDay,
  type SyllabusContent,
  type SyllabusEvent,
} from "@/lib/syllabus";

const UPCOMING_WINDOW_DAYS = 14;

const EMPHASIZED: ReadonlySet<SyllabusEvent["type"]> = new Set([
  "exam",
  "quiz",
  "assignment",
  "project",
  "deadline",
]);

function eventWhen(event: SyllabusEvent): string {
  if (!event.date) return event.dateText ?? "Date not given";
  const start = formatIsoDay(event.date);
  return event.endDate ? `${start} – ${formatIsoDay(event.endDate)}` : start;
}

function EventRow({ event, past }: { event: SyllabusEvent; past?: boolean }) {
  return (
    <li
      className={`flex flex-col gap-1 border-b py-2 last:border-b-0 sm:flex-row sm:items-start sm:gap-4 ${past ? "opacity-60" : ""}`}
    >
      <span className="w-56 shrink-0 text-sm font-medium tabular-nums">
        {eventWhen(event)}
        {event.date && event.dateText && (
          <span className="block text-xs font-normal text-muted-foreground">
            {event.dateText}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={EMPHASIZED.has(event.type) ? "font-semibold" : ""}>
            {event.title}
          </span>
          <Badge
            variant={event.type === "exam" ? "warning" : "secondary"}
            className="text-[10px]"
          >
            {SYLLABUS_EVENT_LABELS[event.type]}
          </Badge>
        </span>
        {event.details && (
          <span className="mt-0.5 block whitespace-pre-wrap text-sm text-muted-foreground">
            {event.details}
          </span>
        )}
      </span>
    </li>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Info;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="size-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function TextSections({ sections }: { sections: SyllabusContent["policies"] }) {
  return (
    <div className="divide-y">
      {sections.map((section, index) => (
        <details key={`${section.title}-${index}`} className="group py-2">
          <summary className="cursor-pointer font-medium marker:text-muted-foreground">
            {section.title}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {section.body}
          </p>
        </details>
      ))}
    </div>
  );
}

export function SyllabusView({
  content,
  today,
}: {
  content: SyllabusContent;
  /** ISO day, computed by the caller so server and client agree. */
  today: string;
}) {
  const upcoming = eventsBetween(
    content,
    today,
    addDays(today, UPCOMING_WINDOW_DAYS - 1),
  ).filter((event) => event.type !== "class" && event.type !== "reading");
  const heading = [content.courseCode, content.courseTitle]
    .filter(Boolean)
    .join(" — ");

  return (
    <div className="space-y-4">
      {(heading ||
        content.term ||
        content.meetingInfo ||
        content.description) && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {heading && <h2 className="text-xl font-semibold">{heading}</h2>}
            {(content.term || content.meetingInfo) && (
              <p className="text-sm text-muted-foreground">
                {[content.term, content.meetingInfo]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {content.description && (
              <p className="whitespace-pre-wrap text-sm">
                {content.description}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {upcoming.length > 0 && (
        <Section icon={CalendarDays} title="Coming up in the next two weeks">
          <ul>
            {upcoming.map((event, index) => (
              <EventRow
                key={`${event.date}-${event.title}-${index}`}
                event={event}
              />
            ))}
          </ul>
        </Section>
      )}

      {content.contacts.length > 0 && (
        <Section icon={Users} title="Instructors & contacts">
          <div className="grid gap-3 sm:grid-cols-2">
            {content.contacts.map((contact, index) => (
              <div
                key={`${contact.name}-${index}`}
                className="rounded-lg border p-3 text-sm"
              >
                <p className="font-medium">{contact.name}</p>
                <p className="text-xs text-muted-foreground">{contact.role}</p>
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="mt-1 flex items-center gap-1 text-primary hover:underline"
                  >
                    <Mail className="size-3" /> {contact.email}
                  </a>
                )}
                {contact.phone && <p className="mt-1">{contact.phone}</p>}
                {contact.office && (
                  <p className="mt-1">Office: {contact.office}</p>
                )}
                {contact.officeHours && (
                  <p className="mt-1 whitespace-pre-wrap">
                    Office hours: {contact.officeHours}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {(content.grading.length > 0 || content.gradingScale) && (
        <Section icon={Scale} title="Grading">
          {content.grading.length > 0 && (
            <table className="w-full text-sm">
              <tbody>
                {content.grading.map((item, index) => (
                  <tr
                    key={`${item.component}-${index}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="py-1.5">{item.component}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">
                      {item.weight}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {content.gradingScale && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {content.gradingScale}
            </p>
          )}
        </Section>
      )}

      {content.schedule.length > 0 && (
        <Section icon={CalendarDays} title="Full schedule">
          <ul>
            {content.schedule.map((event, index) => (
              <EventRow
                key={`${event.date}-${event.title}-${index}`}
                event={event}
                past={
                  event.date !== null && (event.endDate ?? event.date) < today
                }
              />
            ))}
          </ul>
        </Section>
      )}

      {content.policies.length > 0 && (
        <Section icon={ScrollText} title="Course policies">
          <TextSections sections={content.policies} />
        </Section>
      )}

      {content.learningObjectives.length > 0 && (
        <Section icon={GraduationCap} title="Learning objectives">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {content.learningObjectives.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </Section>
      )}

      {content.requiredMaterials.length > 0 && (
        <Section icon={ListChecks} title="Required materials">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {content.requiredMaterials.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </Section>
      )}

      {content.otherInfo.length > 0 && (
        <Section icon={Info} title="Other information">
          <TextSections sections={content.otherInfo} />
        </Section>
      )}
    </div>
  );
}
