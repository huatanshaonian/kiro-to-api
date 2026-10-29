// A catalog entry can be present while its process and tools are still pending.
export function mcpStatus(catalog, name) {
  const entry = catalog.data?.find(item => item.name === name);
  return entry?.status?.status ?? entry?.status ?? 'missing';
}
export function mcpCatalogReady(catalog, names) {
  return names.every(name => mcpStatus(catalog, name) === 'connected');
}
