import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

export function registerResourceCommands(program: Command, api: () => ApiClient): void {
  const resources = program.command("resources").description("Capacity, health and permits");

  resources
    .command("list")
    .description("Each resource's capacity, units held and health")
    .action(async () => print(await api().resources.list.query()));

  resources
    .command("permits")
    .description("Permits not yet released")
    .action(async () => print(await api().resources.permits.query()));

  resources
    .command("release <permitId>")
    .description("Release a permit whose workflow has stopped")
    .action(async (permitId: string) =>
      print(await api().resources.releasePermit.mutate({ permitId })),
    );

  program
    .command("fleet")
    .description("Which workers are up, and whether the queue may start work")
    .action(async () => print(await api().fleet.status.query()));
}
