package dev.kanety.solaria.client.malilib;

import dev.kanety.solaria.client.ClientConfig;
import fi.dy.masa.malilib.config.IConfigOptionListEntry;

/** ClientConfig.GuardMode as a MaLiLib option list entry. */
public enum GuardModeEntry implements IConfigOptionListEntry {
    OFF(ClientConfig.GuardMode.OFF),
    DIFF(ClientConfig.GuardMode.DIFF),
    ALL(ClientConfig.GuardMode.ALL);

    public final ClientConfig.GuardMode mode;

    GuardModeEntry(ClientConfig.GuardMode mode) {
        this.mode = mode;
    }

    public static GuardModeEntry of(ClientConfig.GuardMode mode) {
        for (GuardModeEntry e : values()) if (e.mode == mode) return e;
        return DIFF;
    }

    @Override
    public String getStringValue() {
        return mode.id;
    }

    @Override
    public String getDisplayName() {
        return mode.label;
    }

    @Override
    public IConfigOptionListEntry cycle(boolean forward) {
        int n = values().length;
        return values()[(ordinal() + (forward ? 1 : n - 1)) % n];
    }

    @Override
    public IConfigOptionListEntry fromString(String value) {
        ClientConfig.GuardMode m = ClientConfig.GuardMode.of(value);
        return m == null ? DIFF : of(m);
    }
}
