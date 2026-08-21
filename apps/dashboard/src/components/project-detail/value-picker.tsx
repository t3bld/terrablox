"use client";

import { Button } from "@terrablox/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@terrablox/ui/command";
import { Input } from "@terrablox/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import {
  ArrowLeft,
  Braces,
  ChevronsUpDown,
  Pencil,
  Plus,
  Star,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  formatLocalValue,
  isValidLocalName,
  LOCAL_VALUE_TYPES,
  type LocalValueType,
  localValueTypeOf,
  summariseLocalValue,
  toLocalName,
} from "@/lib/projects/locals";
import { MIN_WIRING_SCORE, wiringScore } from "@/lib/projects/wiring";

/** An existing `locals` entry this input could read. */
export interface VariableOption {
  name: string;
  expression: string | null;
}

/** One `module.<producer>.<output>` this input could read. */
export interface OutputOption {
  producer: string;
  output: string;
}

export type ValueChoice =
  | { kind: "output"; producer: string; output: string }
  | { kind: "variable"; name: string }
  | { kind: "new-variable"; name: string; value: string }
  | { kind: "expression"; value: string };

interface ValuePickerProps {
  /** The input being filled, used to rank outputs and seed a new name. */
  inputName: string;
  variables: VariableOption[];
  outputs: OutputOption[];
  disabled?: boolean;
  onChoose: (choice: ValueChoice) => void;
}

/**
 * Everything one module input could be set to, in one searchable list.
 *
 * Replaces a canvas where values were nodes. A wire from a value to an input said
 * nothing the input could not say itself, and it cost a box and two handles per
 * constant — so a project with a dozen tags read as a system with a dozen extra
 * components.
 *
 * The two families are grouped rather than merged: an output is a fact about
 * another module and a variable is a decision the user made, and a flat list of
 * both invites picking the wrong kind of thing. Matching outputs are starred and
 * float up, because a `vpc_id` input has one plausible source and dozens of
 * implausible ones.
 */
export function ValuePicker({
  inputName,
  variables,
  outputs,
  disabled = false,
  onChoose,
}: ValuePickerProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pick" | "new" | "raw">("pick");

  const ranked = useMemo(
    () =>
      outputs
        .map((option) => ({
          ...option,
          score: wiringScore(inputName, option.output, option.producer),
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.producer.localeCompare(b.producer) ||
            a.output.localeCompare(b.output),
        ),
    [outputs, inputName],
  );

  // Grouped by producing module so a module with twenty outputs reads as one
  // section rather than twenty peers of everything else.
  const byProducer = useMemo(() => {
    const groups = new Map<string, typeof ranked>();
    for (const option of ranked) {
      const existing = groups.get(option.producer);
      if (existing) existing.push(option);
      else groups.set(option.producer, [option]);
    }
    return [...groups.entries()];
  }, [ranked]);

  const close = () => {
    setOpen(false);
    setMode("pick");
  };

  const choose = (choice: ValueChoice) => {
    onChoose(choice);
    close();
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setMode("pick");
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          className="mt-1.5 h-7 w-full justify-between gap-1 px-2 text-xs font-normal text-muted-foreground"
          disabled={disabled}
          size="sm"
          variant="outline"
        >
          Set from…
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0">
        {mode === "pick" ? (
          <Command
            // Filtering across both families at once is the point: the user
            // knows the name they want, not which family it belongs to.
            filter={(value, search) =>
              value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder={`Value for ${inputName}…`} />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>

              {variables.length > 0 ? (
                <CommandGroup heading="Variables">
                  {variables.map((variable) => (
                    <CommandItem
                      key={variable.name}
                      onSelect={() =>
                        choose({ kind: "variable", name: variable.name })
                      }
                      value={`local.${variable.name} ${variable.expression ?? ""}`}
                    >
                      <Braces className="h-3 w-3 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {variable.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {localValueTypeOf(variable.expression)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {byProducer.map(([producer, options]) => (
                <CommandGroup heading={`module.${producer}`} key={producer}>
                  {options.map((option) => (
                    <CommandItem
                      key={`${producer}.${option.output}`}
                      onSelect={() =>
                        choose({
                          kind: "output",
                          producer,
                          output: option.output,
                        })
                      }
                      value={`module.${producer}.${option.output}`}
                    >
                      {option.score >= MIN_WIRING_SCORE ? (
                        <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" />
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {option.output}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}

              <CommandSeparator />

              <CommandGroup>
                <CommandItem
                  onSelect={() => setMode("new")}
                  value="create new variable"
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  <span className="text-xs">New variable…</span>
                </CommandItem>
                <CommandItem
                  onSelect={() => setMode("raw")}
                  value="write an expression by hand"
                >
                  <Pencil className="h-3 w-3 shrink-0" />
                  <span className="text-xs">Write an expression…</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        ) : mode === "new" ? (
          <NewVariableForm
            inputName={inputName}
            onBack={() => setMode("pick")}
            onCreate={(name, value) =>
              choose({ kind: "new-variable", name, value })
            }
            taken={variables.map((variable) => variable.name)}
          />
        ) : (
          <RawExpressionForm
            onBack={() => setMode("pick")}
            onSubmit={(value) => choose({ kind: "expression", value })}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Name, type and value for a variable created from the input that needs it.
 *
 * The name is seeded from the input, which is right almost every time: an input
 * called `vpc_cidr` wants a value called `vpc_cidr`.
 */
function NewVariableForm({
  inputName,
  taken,
  onBack,
  onCreate,
}: {
  inputName: string;
  taken: string[];
  onBack: () => void;
  onCreate: (name: string, value: string) => void;
}) {
  const [name, setName] = useState(() => toLocalName(inputName));
  const [type, setType] = useState<LocalValueType>("string");
  const [raw, setRaw] = useState("");

  const hint =
    LOCAL_VALUE_TYPES.find((entry) => entry.value === type)?.hint ?? "";
  const clash = taken.includes(name.trim());
  const nameOk = isValidLocalName(name) && !clash;
  const valueOk = raw.trim() !== "";

  const submit = () => {
    if (!nameOk || !valueOk) return;
    onCreate(name.trim(), formatLocalValue(type, raw));
  };

  return (
    <form
      className="space-y-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          className="h-6 w-6"
          onClick={onBack}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ArrowLeft className="h-3 w-3" />
        </Button>
        <span className="text-xs font-medium">New variable</span>
      </div>

      <div className="space-y-1">
        <label
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          htmlFor="new-variable-name"
        >
          Name
        </label>
        {/* Focus is safe: this form replaces the item the user just chose. */}
        <Input
          autoFocus
          className="h-7 font-mono text-xs"
          id="new-variable-name"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
        {clash ? (
          <p className="text-[10px] text-destructive">
            A variable called {name.trim()} already exists.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          htmlFor="new-variable-type"
        >
          Type
        </label>
        <select
          className="h-7 w-full rounded-md border bg-background px-2 text-xs"
          id="new-variable-type"
          onChange={(event) => setType(event.target.value as LocalValueType)}
          value={type}
        >
          {LOCAL_VALUE_TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          htmlFor="new-variable-value"
        >
          Value
        </label>
        {type === "bool" ? (
          <select
            className="h-7 w-full rounded-md border bg-background px-2 text-xs"
            id="new-variable-value"
            onChange={(event) => setRaw(event.target.value)}
            value={raw || "true"}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <Input
            className="h-7 font-mono text-xs"
            id="new-variable-value"
            inputMode={type === "number" ? "decimal" : undefined}
            onChange={(event) => setRaw(event.target.value)}
            placeholder={hint}
            value={raw}
          />
        )}
        {/* The written HCL, so quoting is visible before it is committed. */}
        {raw.trim() ? (
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {formatLocalValue(type, raw)}
          </p>
        ) : null}
      </div>

      <Button
        className="h-7 w-full text-xs"
        disabled={!nameOk || !valueOk}
        size="sm"
        type="submit"
      >
        Create and connect
      </Button>
    </form>
  );
}

/** For the references a variable is the wrong shape for: `var.x`, `data.y.z`. */
function RawExpressionForm({
  onBack,
  onSubmit,
}: {
  onBack: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      className="space-y-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          className="h-6 w-6"
          onClick={onBack}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ArrowLeft className="h-3 w-3" />
        </Button>
        <span className="text-xs font-medium">Expression</span>
      </div>

      {/* Focus is safe: this form replaces the item the user just chose. */}
      <Input
        autoFocus
        className="h-7 font-mono text-xs"
        onChange={(event) => setValue(event.target.value)}
        placeholder="var.environment"
        value={value}
      />
      <p className="text-[10px] text-muted-foreground">
        Written through unchanged, so quote a literal string yourself.
      </p>

      <Button
        className="h-7 w-full text-xs"
        disabled={value.trim() === ""}
        size="sm"
        type="submit"
      >
        Set value
      </Button>
    </form>
  );
}

/** Label for a value already set on an input, for the row above the picker. */
export function describeValue(value: string): string {
  return summariseLocalValue(value, 40);
}
