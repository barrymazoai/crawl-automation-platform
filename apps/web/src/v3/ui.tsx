import type { ReactNode } from "react";
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  Table,
  TextField,
} from "@heroui/react";
import { ArrowRight, Box, Info, Search } from "lucide-react";
import type { Channel, Product } from "./data/model";

export function PageHead({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description: string;
  eyebrow: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-center justify-between gap-5">
      <div>
        <p className="mb-2 text-[10px] tracking-[.2em] text-muted">
          WORKSPACE / {eyebrow}
        </p>
        <h1 className="text-[28px] font-semibold tracking-tight md:text-[31px]">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-xs leading-6 text-muted">
          {description}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </header>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={`min-w-0 gap-0 overflow-hidden border border-border p-0 shadow-none ${className}`}
    >
      {title && (
        <Card.Header className="flex flex-row items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {subtitle && (
              <Card.Description className="mt-1 text-[11px]">
                {subtitle}
              </Card.Description>
            )}
          </div>
          {action}
        </Card.Header>
      )}
      <Card.Content className="p-0">{children}</Card.Content>
    </Card>
  );
}
export function Note({
  children,
  warning = false,
}: {
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs leading-6 ${warning ? "border-amber-200 bg-amber-50 text-amber-800" : "border-[#dce7d2] bg-[#eff5e8] text-[#527044]"}`}
    >
      <Info size={15} className="mt-1 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
export function BrandAvatar({ brand }: { brand: { name: string } }) {
  return (
    <Avatar
      size="sm"
      className="shrink-0 rounded-xl bg-[#eef3e5] text-[#5b7744]"
    >
      <Avatar.Fallback className="text-[11px] font-bold">
        {brand.name
          .split(/\s+/)
          .slice(0, 2)
          .map((s) => s.slice(0, 1))
          .join("")}
      </Avatar.Fallback>
    </Avatar>
  );
}
export function ChannelChip({ channel }: { channel: Channel }) {
  const colors = {
    Amazon: "border-[#e9dfc9] bg-[#fbf6eb] text-[#8b692b]",
    GNC: "border-[#efded4] bg-[#fcf2ec] text-[#9a6752]",
    Swanson: "border-[#e0e9ce] bg-[#f2f7e8] text-[#668443]",
    DTC: "border-[#dce8df] bg-[#eff5f0] text-[#527463]",
  };
  return (
    <Chip
      size="sm"
      variant="soft"
      className={`h-6 rounded-md border px-1.5 text-[10px] ${colors[channel]}`}
    >
      {channel}
    </Chip>
  );
}
export function Status({
  value,
  label,
}: {
  value: Product["status"] | "running" | "queued";
  label?: string;
}) {
  const names = {
    saved: "已保存",
    synced: "已同步正式库",
    unmapped: "待关联公司",
    review: "Review",
    running: "运行中",
    queued: "等待领取",
  };
  const color =
    value === "unmapped" || value === "review"
      ? "warning"
      : value === "queued"
        ? "default"
        : "success";
  return (
    <Chip
      size="sm"
      color={color}
      variant="soft"
      className="gap-1.5 rounded-md text-[10px]"
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label || names[value]}
    </Chip>
  );
}
export function SelectField({
  label,
  value,
  onChange,
  options,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { id: string; label: string }[];
  compact?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className={compact ? "w-36 shrink-0" : "w-full"}
    >
      {!compact && <Label>{label}</Label>}
      <Select.Trigger className="min-h-10 rounded-lg text-xs">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={option.label}
            >
              <Label>{option.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
export function Field({
  label,
  name,
  value,
  onChange,
  required = false,
  placeholder = "",
  type = "text",
  help,
}: {
  label: string;
  name?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "url" | "time";
  help?: string;
}) {
  return (
    <TextField
      {...(name ? { name } : {})}
      value={value}
      onChange={onChange}
      isRequired={required}
      type={type}
      className="w-full"
    >
      <Label>{label}</Label>
      <Input
        placeholder={placeholder}
        maxLength={type === "url" ? 2000 : 120}
        className="rounded-lg text-sm"
      />
      {help && <Description>{help}</Description>}
      <FieldError />
    </TextField>
  );
}
export function SearchInput({
  value,
  onChange,
  label = "搜索",
  placeholder = "搜索品牌、产品…",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <TextField
      aria-label={label}
      value={value}
      onChange={onChange}
      className="relative min-w-36 flex-1 md:max-w-xs"
    >
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-3 text-muted"
      />
      <Input
        className="min-h-10 rounded-lg pl-9 text-xs"
        placeholder={placeholder}
      />
    </TextField>
  );
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Switch aria-label={label} isSelected={value} onChange={onChange} size="sm">
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}
export function Check({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Checkbox
      aria-label={label}
      isSelected={checked}
      isDisabled={disabled}
      onChange={onChange}
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}
export function Empty({
  title = "没有匹配的记录",
  description = "试试其他关键词或筛选条件。",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="px-6 py-14 text-center">
      <Box className="mx-auto mb-3 text-muted" size={26} />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-2 text-xs text-muted">{description}</p>
    </div>
  );
}
export function TextButton({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={onPress}
      className="gap-1.5 px-2 text-xs text-accent"
    >
      {children}
      <ArrowRight size={13} />
    </Button>
  );
}
export function Kv({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-5 border-b border-border py-3 text-xs last:border-b-0">
      <span className="shrink-0 text-muted">{label}</span>
      <div className="min-w-0 text-right [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}
export function DataTable<T extends { id: string }>({
  label,
  rows,
  columns,
}: {
  label: string;
  rows: T[];
  columns: { id: string; title: string; render: (row: T) => ReactNode }[];
}) {
  return (
    <Table className="rounded-none border-0">
      <Table.ScrollContainer>
        <Table.Content aria-label={label} className="min-w-[730px]">
          <Table.Header>
            {columns.map((column, i) => (
              <Table.Column
                id={column.id}
                key={column.id}
                isRowHeader={i === 0}
                className="bg-[#fafbf7] px-5 py-3 text-[11px] font-medium text-muted"
              >
                {column.title}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body items={rows} renderEmptyState={() => <Empty />}>
            {(row) => (
              <Table.Row id={row.id} className="hover:bg-[#fafcf6]">
                {columns.map((column) => (
                  <Table.Cell
                    key={column.id}
                    className="border-b border-border px-5 py-4 text-xs"
                  >
                    {column.render(row)}
                  </Table.Cell>
                ))}
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
