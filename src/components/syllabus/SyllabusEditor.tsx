"use client";

// Direct editing of an extracted syllabus. The draft is plain SyllabusContent;
// the server runs it through the same normalizer as model output on save, so
// blank rows the teacher left behind are simply dropped there.

import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  SYLLABUS_EVENT_LABELS,
  SYLLABUS_EVENT_TYPES,
  sortSchedule,
  type SyllabusContact,
  type SyllabusContent,
  type SyllabusEvent,
  type SyllabusSection,
} from "@/lib/syllabus";

type Patch = (next: Partial<SyllabusContent>) => void;

/** Replace item `index` of `items` with `value`. */
function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, i) => (i === index ? value : item));
}

function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

function EditorCard({
  title,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  onAdd?: () => void;
  addLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-lg">{title}</CardTitle>
        {onAdd && (
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-4" /> {addLabel ?? "Add"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function RemoveButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      onClick={onClick}
      className="shrink-0 text-muted-foreground hover:text-destructive"
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  multiline,
  placeholder,
}: {
  id: string;
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {multiline ? (
        <Textarea
          id={id}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
        />
      ) : (
        <Input
          id={id}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

function CourseFields({
  draft,
  patch,
}: {
  draft: SyllabusContent;
  patch: Patch;
}) {
  return (
    <EditorCard title="Course">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="courseTitle"
          label="Course title"
          value={draft.courseTitle}
          onChange={(v) => patch({ courseTitle: v })}
        />
        <Field
          id="courseCode"
          label="Course code"
          value={draft.courseCode}
          onChange={(v) => patch({ courseCode: v })}
        />
        <Field
          id="term"
          label="Term"
          value={draft.term}
          placeholder="Fall 2026"
          onChange={(v) => patch({ term: v })}
        />
        <Field
          id="meetingInfo"
          label="Meeting times & location"
          value={draft.meetingInfo}
          onChange={(v) => patch({ meetingInfo: v })}
        />
      </div>
      <Field
        id="description"
        label="Description"
        value={draft.description}
        multiline
        onChange={(v) => patch({ description: v })}
      />
      <Field
        id="gradingScale"
        label="Grading scale"
        value={draft.gradingScale}
        multiline
        placeholder="A 90–100, B 80–89, …"
        onChange={(v) => patch({ gradingScale: v })}
      />
    </EditorCard>
  );
}

const EMPTY_CONTACT: SyllabusContact = {
  role: "Instructor",
  name: "",
  email: null,
  phone: null,
  office: null,
  officeHours: null,
};

function ContactsEditor({
  draft,
  patch,
}: {
  draft: SyllabusContent;
  patch: Patch;
}) {
  const set = (index: number, next: Partial<SyllabusContact>) =>
    patch({
      contacts: replaceAt(draft.contacts, index, {
        ...draft.contacts[index],
        ...next,
      }),
    });
  return (
    <EditorCard
      title="Instructors & contacts"
      addLabel="Add contact"
      onAdd={() => patch({ contacts: [...draft.contacts, EMPTY_CONTACT] })}
    >
      {draft.contacts.map((contact, index) => (
        <div key={index} className="flex gap-2 rounded-lg border p-3">
          <div className="grid flex-1 gap-2 sm:grid-cols-3">
            <Field
              id={`contact-${index}-role`}
              label="Role"
              value={contact.role}
              onChange={(v) => set(index, { role: v })}
            />
            <Field
              id={`contact-${index}-name`}
              label="Name"
              value={contact.name}
              onChange={(v) => set(index, { name: v })}
            />
            <Field
              id={`contact-${index}-email`}
              label="Email"
              value={contact.email}
              onChange={(v) => set(index, { email: v })}
            />
            <Field
              id={`contact-${index}-phone`}
              label="Phone"
              value={contact.phone}
              onChange={(v) => set(index, { phone: v })}
            />
            <Field
              id={`contact-${index}-office`}
              label="Office"
              value={contact.office}
              onChange={(v) => set(index, { office: v })}
            />
            <Field
              id={`contact-${index}-hours`}
              label="Office hours"
              value={contact.officeHours}
              onChange={(v) => set(index, { officeHours: v })}
            />
          </div>
          <RemoveButton
            label="Remove contact"
            onClick={() => patch({ contacts: removeAt(draft.contacts, index) })}
          />
        </div>
      ))}
    </EditorCard>
  );
}

function GradingEditor({
  draft,
  patch,
}: {
  draft: SyllabusContent;
  patch: Patch;
}) {
  return (
    <EditorCard
      title="Grading breakdown"
      addLabel="Add component"
      onAdd={() =>
        patch({ grading: [...draft.grading, { component: "", weight: "" }] })
      }
    >
      {draft.grading.map((item, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1">
            <Field
              id={`grade-${index}-component`}
              label="Component"
              value={item.component}
              onChange={(v) =>
                patch({
                  grading: replaceAt(draft.grading, index, {
                    ...item,
                    component: v,
                  }),
                })
              }
            />
          </div>
          <div className="w-32">
            <Field
              id={`grade-${index}-weight`}
              label="Weight"
              value={item.weight}
              placeholder="20%"
              onChange={(v) =>
                patch({
                  grading: replaceAt(draft.grading, index, {
                    ...item,
                    weight: v,
                  }),
                })
              }
            />
          </div>
          <RemoveButton
            label="Remove grading component"
            onClick={() => patch({ grading: removeAt(draft.grading, index) })}
          />
        </div>
      ))}
    </EditorCard>
  );
}

const EMPTY_EVENT: SyllabusEvent = {
  date: null,
  endDate: null,
  dateText: null,
  title: "",
  type: "assignment",
  details: null,
};

function ScheduleEditor({
  draft,
  patch,
}: {
  draft: SyllabusContent;
  patch: Patch;
}) {
  const set = (index: number, next: Partial<SyllabusEvent>) =>
    patch({
      schedule: replaceAt(draft.schedule, index, {
        ...draft.schedule[index],
        ...next,
      }),
    });
  return (
    <EditorCard
      title="Schedule & dates"
      addLabel="Add date"
      onAdd={() => patch({ schedule: [...draft.schedule, EMPTY_EVENT] })}
    >
      {draft.schedule.map((event, index) => (
        <div key={index} className="flex gap-2 rounded-lg border p-3">
          <div className="grid flex-1 gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor={`event-${index}-date`} className="text-xs">
                Date
              </Label>
              <Input
                id={`event-${index}-date`}
                type="date"
                value={event.date ?? ""}
                onChange={(e) => set(index, { date: e.target.value || null })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`event-${index}-end`} className="text-xs">
                End date (optional)
              </Label>
              <Input
                id={`event-${index}-end`}
                type="date"
                value={event.endDate ?? ""}
                onChange={(e) =>
                  set(index, { endDate: e.target.value || null })
                }
              />
            </div>
            <Field
              id={`event-${index}-text`}
              label="As written"
              value={event.dateText}
              placeholder="Week 3"
              onChange={(v) => set(index, { dateText: v })}
            />
            <div className="space-y-1">
              <Label htmlFor={`event-${index}-type`} className="text-xs">
                Type
              </Label>
              <select
                id={`event-${index}-type`}
                value={event.type}
                onChange={(e) =>
                  set(index, { type: e.target.value as SyllabusEvent["type"] })
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              >
                {SYLLABUS_EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {SYLLABUS_EVENT_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <Field
                id={`event-${index}-title`}
                label="Title"
                value={event.title}
                onChange={(v) => set(index, { title: v })}
              />
            </div>
            <div className="sm:col-span-2">
              <Field
                id={`event-${index}-details`}
                label="Details"
                value={event.details}
                onChange={(v) => set(index, { details: v })}
              />
            </div>
          </div>
          <RemoveButton
            label="Remove date"
            onClick={() => patch({ schedule: removeAt(draft.schedule, index) })}
          />
        </div>
      ))}
    </EditorCard>
  );
}

function SectionsEditor({
  title,
  sections,
  onChange,
  idPrefix,
}: {
  title: string;
  sections: SyllabusSection[];
  onChange: (next: SyllabusSection[]) => void;
  idPrefix: string;
}) {
  return (
    <EditorCard
      title={title}
      addLabel="Add section"
      onAdd={() => onChange([...sections, { title: "", body: "" }])}
    >
      {sections.map((section, index) => (
        <div key={index} className="flex gap-2 rounded-lg border p-3">
          <div className="flex-1 space-y-2">
            <Field
              id={`${idPrefix}-${index}-title`}
              label="Title"
              value={section.title}
              onChange={(v) =>
                onChange(replaceAt(sections, index, { ...section, title: v }))
              }
            />
            <Field
              id={`${idPrefix}-${index}-body`}
              label="Text"
              value={section.body}
              multiline
              onChange={(v) =>
                onChange(replaceAt(sections, index, { ...section, body: v }))
              }
            />
          </div>
          <RemoveButton
            label="Remove section"
            onClick={() => onChange(removeAt(sections, index))}
          />
        </div>
      ))}
    </EditorCard>
  );
}

function ListEditor({
  title,
  items,
  onChange,
  idPrefix,
}: {
  title: string;
  items: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <EditorCard title={title} onAdd={() => onChange([...items, ""])}>
      {items.map((item, index) => (
        <div key={index} className="flex gap-2">
          <Input
            aria-label={`${title} ${index + 1}`}
            id={`${idPrefix}-${index}`}
            value={item}
            onChange={(e) => onChange(replaceAt(items, index, e.target.value))}
          />
          <RemoveButton
            label="Remove item"
            onClick={() => onChange(removeAt(items, index))}
          />
        </div>
      ))}
    </EditorCard>
  );
}

export function SyllabusEditor({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: SyllabusContent;
  saving: boolean;
  onSave: (content: SyllabusContent) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const patch: Patch = (next) =>
    setDraft((current) => ({ ...current, ...next }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...draft, schedule: sortSchedule(draft.schedule) });
      }}
    >
      <CourseFields draft={draft} patch={patch} />
      <ScheduleEditor draft={draft} patch={patch} />
      <ContactsEditor draft={draft} patch={patch} />
      <GradingEditor draft={draft} patch={patch} />
      <SectionsEditor
        title="Course policies"
        idPrefix="policy"
        sections={draft.policies}
        onChange={(policies) => patch({ policies })}
      />
      <ListEditor
        title="Learning objectives"
        idPrefix="objective"
        items={draft.learningObjectives}
        onChange={(learningObjectives) => patch({ learningObjectives })}
      />
      <ListEditor
        title="Required materials"
        idPrefix="material"
        items={draft.requiredMaterials}
        onChange={(requiredMaterials) => patch({ requiredMaterials })}
      />
      <SectionsEditor
        title="Other information"
        idPrefix="other"
        sections={draft.otherInfo}
        onChange={(otherInfo) => patch({ otherInfo })}
      />

      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />} Save changes
        </Button>
      </div>
    </form>
  );
}
