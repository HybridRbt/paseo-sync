import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SyncScreen } from "./client/sync";
function Item({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="RefreshCw"
      active={currentScreen?.screenId === "sync"}
      onPress={() => openScreen({ screenId: "sync" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "sync", title: "Paseo Sync", Component: SyncScreen });
  client.addSettingsScreen({
    id: "sync",
    title: "Paseo Sync",
    icon: "RefreshCw",
    Component: SyncScreen,
  });
  client.addSidebarFooterItem({
    id: "sync",
    title: "Paseo Sync",
    Component: Item,
  });
  return () => {};
}
