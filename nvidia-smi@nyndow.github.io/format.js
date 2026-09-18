// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Nyndow

// Pure parsing/formatting helpers with no GNOME imports, so they can be
// unit-tested outside the Shell.

/** Fields requested from `nvidia-smi --query-gpu`, in the order parseGpuQuery() expects. */
export const GPU_QUERY_FIELDS = [
    'index',
    'name',
    'memory.used',
    'memory.total',
    'utilization.gpu',
    'temperature.gpu',
    'power.draw',
    'power.limit',
];

export const DISPLAY_MODES = ['percent', 'gib', 'mib'];

function toNumber(token) {
    const value = parseFloat(token);
    return Number.isFinite(value) ? value : null;
}

/**
 * Parse the CSV emitted by `nvidia-smi --query-gpu=<GPU_QUERY_FIELDS> --format=csv,noheader,nounits`.
 *
 * Fields nvidia-smi reports as "[N/A]" (for example power on laptops) become null.
 *
 * @param {string} csvOutput
 * @returns {Array<{index: number, name: string, memoryUsed: number, memoryTotal: number,
 *   utilization: number|null, temperature: number|null, powerDraw: number|null, powerLimit: number|null}>}
 */
export function parseGpuQuery(csvOutput) {
    const lines = csvOutput.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length === 0)
        throw new Error('nvidia-smi reported no GPUs');

    return lines.map(line => {
        const tokens = line.split(',').map(token => token.trim());
        if (tokens.length < GPU_QUERY_FIELDS.length)
            throw new Error(`unparseable nvidia-smi line: ${line}`);

        // GPU names never contain commas, but be defensive about extra columns.
        const [index, name, used, total, util, temp, draw, limit] = tokens;
        const memoryUsed = toNumber(used);
        const memoryTotal = toNumber(total);
        if (memoryUsed === null || memoryTotal === null)
            throw new Error(`unparseable nvidia-smi line: ${line}`);

        return {
            index: toNumber(index) ?? 0,
            name,
            memoryUsed,
            memoryTotal,
            utilization: toNumber(util),
            temperature: toNumber(temp),
            powerDraw: toNumber(draw),
            powerLimit: toNumber(limit),
        };
    });
}

/**
 * Sum VRAM across GPUs.
 *
 * @param {ReturnType<typeof parseGpuQuery>} gpus
 * @returns {{used: number, total: number, fraction: number}}
 */
export function summarizeVram(gpus) {
    let used = 0;
    let total = 0;
    for (const gpu of gpus) {
        used += gpu.memoryUsed;
        total += gpu.memoryTotal;
    }
    return {used, total, fraction: total > 0 ? used / total : 0};
}

/**
 * Format the top-bar text.
 *
 * @param {number} used MiB
 * @param {number} total MiB
 * @param {string} mode one of DISPLAY_MODES
 * @returns {string}
 */
export function formatVramLabel(used, total, mode) {
    switch (mode) {
    case 'gib':
        return `${(used / 1024).toFixed(1)}/${(total / 1024).toFixed(1)} GiB`;
    case 'mib':
        return `${Math.round(used)}/${Math.round(total)} MiB`;
    case 'percent':
    default:
        return `${Math.round(total > 0 ? (used / total) * 100 : 0)}%`;
    }
}

/**
 * Map a usage fraction to a pressure level.
 *
 * @param {number} fraction 0..1
 * @param {number} warningPercent
 * @param {number} criticalPercent
 * @returns {'critical'|'warning'|null}
 */
export function pressureLevel(fraction, warningPercent, criticalPercent) {
    const percent = fraction * 100;
    if (criticalPercent > 0 && percent >= criticalPercent)
        return 'critical';
    if (warningPercent > 0 && percent >= warningPercent)
        return 'warning';
    return null;
}

// Matches one row of the "Processes:" table of plain `nvidia-smi` output, for both the
// modern layout (GPU, GI ID, CI ID, PID, Type, Name, Memory) and the pre-450 driver layout
// without the GI/CI columns. Truncated names start with "..." and memory may be "N/A".
const PROCESS_LINE = /^\|\s*(\d+)\s+(?:(?:N\/A|\d+)\s+(?:N\/A|\d+)\s+)?(\d+)\s+([CG+]+|N\/A)\s+(.*?)\s+(?:(\d+)MiB|N\/A)\s*\|$/;

/**
 * Extract the process table from plain `nvidia-smi` output, sorted by memory (desc).
 *
 * @param {string} rawOutput
 * @returns {Array<{gpu: number, pid: number, type: string, name: string, memoryMiB: number|null}>}
 */
export function parseProcesses(rawOutput) {
    const lines = rawOutput.split('\n');
    const start = lines.findIndex(line => line.includes('Processes:'));
    if (start < 0)
        return [];

    const processes = [];
    for (const line of lines.slice(start + 1)) {
        const match = PROCESS_LINE.exec(line.trimEnd());
        if (!match)
            continue;
        const [, gpu, pid, type, name, memory] = match;
        processes.push({
            gpu: parseInt(gpu, 10),
            pid: parseInt(pid, 10),
            type,
            name,
            memoryMiB: memory === undefined ? null : parseInt(memory, 10),
        });
    }

    return processes.sort((a, b) => (b.memoryMiB ?? -1) - (a.memoryMiB ?? -1) || a.pid - b.pid);
}

/**
 * Turn a (possibly "..."-truncated) path from the process table into a short display name.
 *
 * @param {string} rawName
 * @returns {string}
 */
export function shortProcessName(rawName) {
    const trimmed = rawName.replace(/^\.\.\./, '');
    const base = trimmed.split('/').filter(part => part.length > 0).pop() ?? trimmed;
    return base || rawName;
}
