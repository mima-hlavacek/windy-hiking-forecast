export interface PickerRow {
    id: 'base' | 'dithered' | 'wind';
    label: string;
    value: string;
}

export function createPickerRows(container: HTMLElement): (rows: PickerRow[]) => void {
    // Touch events keep their original target for the whole gesture. Removing that target
    // would keep later movement and release events from reaching Leaflet's document listeners.
    const slots = (['base', 'dithered', 'wind'] as const).map(id => {
        const row = document.createElement('div');
        row.className = 'slo-picker-row';
        row.hidden = true;
        const label = textSpan('slo-picker-label');
        const value = textSpan('slo-picker-value');
        row.append(label, value);
        container.append(row);
        return { id, row, label, value };
    });

    return rows => {
        for (const slot of slots) {
            const data = rows.find(row => row.id === slot.id);
            slot.row.hidden = !data;
            slot.label.textContent = data?.label ?? '';
            slot.value.textContent = data?.value ?? '';
        }
    };
}

function textSpan(className: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
}
