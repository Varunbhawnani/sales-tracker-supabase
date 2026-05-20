import * as XLSX from 'xlsx';
import { saveAndShareExcel } from './exportShare';
import { formatDateIST, formatDateOnly, formatDateForFilename } from '../utils/timeUtils';
import { formatPercentage } from '../utils/formatUtils';
import { STATUS, LEGACY_STATUS, STATUS_LABELS } from '../utils/constants';

// Statuses that represent confirmed/in-progress sales for the master export.
// Verification_failed is excluded — matches the leaderboard's WON_STATUSES.
const EXPORT_WON_STATUSES = new Set([
  STATUS.WON_PENDING_ACCOUNTS,
  STATUS.PENDING_VERIFICATION,
  STATUS.VERIFIED_PENDING_DISPATCH,
  STATUS.PARTIALLY_DISPATCHED,
  STATUS.COMPLETED,
  LEGACY_STATUS.SUCCESSFUL,
]);
const EXPORT_LOST_STATUSES = new Set([
  STATUS.LOST_CANCELLED,
  LEGACY_STATUS.UNSUCCESSFUL,
]);

/**
 * Build per-customer aggregates from the queries collection.
 * Used for the Customers sheet of the master export.
 */
function aggregateCustomers(customers, queries) {
  const map = new Map();
  customers.forEach(c => {
    map.set(c.id, {
      name: c.name || '',
      category: c.category || 'D',
      priceLevel: c.priceLevel || 'Standard',
      parentGroup: c.parentGroup || '',
      totalSetsSold: 0,
      totalSuccessful: 0,
      totalUnsuccessful: 0,
      lastOrderDate: null,
    });
  });

  (queries || []).forEach(q => {
    if (!q.customerMasterId) return;
    const c = map.get(q.customerMasterId);
    if (!c) return;

    if (EXPORT_WON_STATUSES.has(q.status)) {
      c.totalSuccessful += 1;
      c.totalSetsSold += (q.requiredSets || q.setsSold || 0);
      const candidate = q.completedAt || q.wonAt || q.closedAt || null;
      if (candidate && (!c.lastOrderDate || candidate > c.lastOrderDate)) {
        c.lastOrderDate = candidate;
      }
    }
    if (EXPORT_LOST_STATUSES.has(q.status)) {
      c.totalUnsuccessful += 1;
    }
  });

  return Array.from(map.values());
}

/**
 * Get a human-readable status label for export.
 */
function getStatusLabel(status) {
  return STATUS_LABELS[status] || (status || '').replace(/_/g, ' ').toUpperCase();
}

/**
 * Format items list as a readable string for export.
 */
function formatItemsList(items) {
  if (!items || items.length === 0) return '';
  return items.map(i => `${i.productName || 'Product'} (${i.quantity} × ₹${i.unitPrice || 0})`).join('; ');
}

/**
 * Export 1 — Queries Export (handles both new and legacy data)
 */
export async function exportQueries(queries, filterLabel = 'All') {
  if (!queries || queries.length === 0) {
    throw new Error('No data to export.');
  }
  
  const data = queries.map(q => ({
    'Query ID': q.id,
    'Customer Name': q.customerName || q.partyName || '',
    'Category': q.customerCategory || '',
    'Items': formatItemsList(q.items),
    'Required Sets': q.requiredSets || q.quantityRequested || 0,
    'Sets Sold': q.setsSold || '',
    'Dispatched Sets': q.dispatchedSets || '',
    'Projected Revenue': q.projectedRevenue || '',
    'Status': getStatusLabel(q.status),
    'Entered By': q.createdBy?.name || '',
    'Date Entered': q.createdAt ? formatDateIST(q.createdAt) : '',
    'Claimed By': q.claimedBy?.name || '',
    'Date Claimed': q.claimedAt ? formatDateIST(q.claimedAt) : '',
    'Date Won': q.wonAt ? formatDateIST(q.wonAt) : '',
    'Invoice #': q.tallyInvoiceNumber || '',
    'Date Closed': q.closedAt ? formatDateIST(q.closedAt) : '',
    'Date Completed': q.completedAt ? formatDateIST(q.completedAt) : '',
    'Failure Reason': q.failureReason || '',
    'Notes': q.notes || '',
  }));
  
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Queries');
  
  const colWidths = Object.keys(data[0]).map(key => ({
    wch: Math.max(key.length, ...data.map(row => String(row[key]).length)) + 2,
  }));
  ws['!cols'] = colWidths;
  
  const filename = `Queries_Export_${formatDateForFilename()}.xlsx`;
  return saveAndShareExcel(wb, filename);
}

/**
 * Export 2 — Parties Export (legacy, kept for backward compat)
 */
export async function exportParties(parties, thresholdDays) {
  if (!parties || parties.length === 0) {
    throw new Error('No data to export.');
  }
  
  const { getPartyStatus } = await import('../utils/timeUtils');
  
  const data = parties.map(p => {
    const status = getPartyStatus(p.lastOrderDate, p.totalSetsSold, thresholdDays);
    const statusLabel = status === 'active' ? 'Active' : status === 'gone_quiet' ? 'Gone Quiet' : 'New';
    
    return {
      'Party Name': p.name || '',
      'Category': p.category || '',
      'Total Sets Sold': p.totalSetsSold || 0,
      'Total Successful Orders': p.totalSuccessful || 0,
      'Total Unsuccessful': p.totalUnsuccessful || 0,
      'Last Order Date': p.lastOrderDate ? formatDateOnly(p.lastOrderDate) : '',
      'Status': statusLabel,
      'Notes': p.notes || '',
      'Date Added': p.createdAt ? formatDateOnly(p.createdAt) : '',
    };
  });
  
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Parties');
  
  const colWidths = Object.keys(data[0]).map(key => ({
    wch: Math.max(key.length, ...data.map(row => String(row[key]).length)) + 2,
  }));
  ws['!cols'] = colWidths;
  
  const filename = `Parties_Export_${formatDateForFilename()}.xlsx`;
  return saveAndShareExcel(wb, filename);
}

/**
 * Export 3 — Salesperson Performance / Leaderboard Export
 */
export async function exportLeaderboard(leaderboardData, periodLabel = 'AllTime') {
  if (!leaderboardData || leaderboardData.length === 0) {
    throw new Error('No data to export.');
  }
  
  const data = leaderboardData.map(s => ({
    'Rank': s.rank || '',
    'Salesperson Name': s.name || '',
    'Total Sets Sold': s.totalSetsSold || 0,
    'Total Successful': s.totalSuccessful || 0,
    'Total Unsuccessful': s.totalUnsuccessful || 0,
    'Success Rate %': s.totalClaimed > 0
      ? formatPercentage(s.totalSuccessful, s.totalClaimed)
      : '0.0%',
    'Total Queries Claimed': s.totalClaimed || 0,
  }));
  
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Salesperson Stats');
  
  const colWidths = Object.keys(data[0]).map(key => ({
    wch: Math.max(key.length, ...data.map(row => String(row[key]).length)) + 2,
  }));
  ws['!cols'] = colWidths;
  
  const filename = `Leaderboard_${periodLabel}_${formatDateForFilename()}.xlsx`;
  return saveAndShareExcel(wb, filename);
}

/**
 * Export 4 — Master Export (3 sheets in one file)
 *
 * `customers` should be the customers_master records (synced from Tally).
 * Per-customer stats are computed live from `queries` so the sheet stays
 * accurate even though customers_master itself only holds catalog data.
 */
export async function exportAll(queries, customers, leaderboardData, thresholdDays) {
  const wb = XLSX.utils.book_new();
  const { getPartyStatus } = await import('../utils/timeUtils');

  // Sheet 1: Queries
  if (queries && queries.length > 0) {
    const queriesData = queries.map(q => ({
      'Query ID': q.id,
      'Customer Name': q.customerName || q.partyName || '',
      'Category': q.customerCategory || '',
      'Items': formatItemsList(q.items),
      'Required Sets': q.requiredSets || q.quantityRequested || 0,
      'Sets Sold': q.setsSold || '',
      'Dispatched Sets': q.dispatchedSets || '',
      'Projected Revenue': q.projectedRevenue || '',
      'Status': getStatusLabel(q.status),
      'Entered By': q.createdBy?.name || '',
      'Date Entered': q.createdAt ? formatDateIST(q.createdAt) : '',
      'Claimed By': q.claimedBy?.name || '',
      'Date Claimed': q.claimedAt ? formatDateIST(q.claimedAt) : '',
      'Date Won': q.wonAt ? formatDateIST(q.wonAt) : '',
      'Invoice #': q.tallyInvoiceNumber || '',
      'Date Closed': q.closedAt ? formatDateIST(q.closedAt) : '',
      'Failure Reason': q.failureReason || '',
      'Notes': q.notes || '',
    }));
    const ws1 = XLSX.utils.json_to_sheet(queriesData);
    XLSX.utils.book_append_sheet(wb, ws1, 'Queries');
  }

  // Sheet 2: Customers (master + aggregated stats from queries)
  if (customers && customers.length > 0) {
    const aggregated = aggregateCustomers(customers, queries);
    const customersData = aggregated.map(c => {
      const status = getPartyStatus(c.lastOrderDate, c.totalSetsSold, thresholdDays);
      const statusLabel = status === 'active' ? 'Active' : status === 'gone_quiet' ? 'Gone Quiet' : 'New';
      return {
        'Name': c.name,
        'Category': c.category,
        'Price Level': c.priceLevel,
        'Parent Group': c.parentGroup,
        'Total Sets Sold': c.totalSetsSold,
        'Total Successful': c.totalSuccessful,
        'Total Unsuccessful': c.totalUnsuccessful,
        'Last Order Date': c.lastOrderDate ? formatDateOnly(c.lastOrderDate) : '',
        'Status': statusLabel,
      };
    });
    const ws2 = XLSX.utils.json_to_sheet(customersData);
    XLSX.utils.book_append_sheet(wb, ws2, 'Customers');
  }
  
  // Sheet 3: Salesperson Stats
  if (leaderboardData && leaderboardData.length > 0) {
    const lbData = leaderboardData.map(s => ({
      'Rank': s.rank || '',
      'Salesperson Name': s.name || '',
      'Total Sets Sold': s.totalSetsSold || 0,
      'Total Successful': s.totalSuccessful || 0,
      'Total Unsuccessful': s.totalUnsuccessful || 0,
      'Success Rate %': s.totalClaimed > 0
        ? formatPercentage(s.totalSuccessful, s.totalClaimed)
        : '0.0%',
      'Total Queries Claimed': s.totalClaimed || 0,
    }));
    const ws3 = XLSX.utils.json_to_sheet(lbData);
    XLSX.utils.book_append_sheet(wb, ws3, 'Salesperson Stats');
  }
  
  const filename = `SalesTracker_FullExport_${formatDateForFilename()}.xlsx`;
  return saveAndShareExcel(wb, filename);
}
