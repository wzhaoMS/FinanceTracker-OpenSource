// Tailscale assigns node addresses from the CGNAT range and its fixed IPv6 ULA prefix.
export const TAILNET_SUBNETS = [['100.64.0.0', 10, 'ipv4'], ['fd7a:115c:a1e0::', 48, 'ipv6']] as const;
