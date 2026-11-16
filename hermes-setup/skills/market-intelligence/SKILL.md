---
name: market-intelligence
description: Use when checking prices or products. Verify live pages.
version: 1.1.0
license: MIT
---

# Market Intelligence

## Overview

Conduct deep, verified research on products, pricing and competitors. The goal is not to "find information" but to "verify facts" using primary, live sources.

## The Verification Principle

**A price is only as good as the page it was read from, today.**

Never quote a price from a search-result snippet, a cached copy, a price-comparison summary or your own memory; these are leads for finding the page, not evidence.

## Procedure

### 1. Lead generation
- Use `web_search` (or a scraping service's search tool, if installed) to find potential retailers, distributors or product listings.
- Identify a set of good leads before attempting to verify them.

### 2. Direct page access and verification
- Open the candidate page with `web_extract` first.
- **Resilience:** if the price is missing, the page is blocked, or it is built with JavaScript, try a live scrape of the same URL (for example `firecrawl_scrape`, if available). Use the browser if both fail.
- **Verify the identity:** check that the listing is the exact item: model number, capacity, variant (new/used/refurbished) and warranty region. A cheaper "match" that is a different variant is a wrong answer.
- **Verify the money:** for every price, confirm:
    - The exact currency.
    - Whether tax (VAT/sales tax) and delivery are included, as stated on the page.
    - The seller (retailer vs. marketplace third party).
    - Stock status.

### 3. Regional focus
- Unless told otherwise, the primary market is the user's own country (ask once if it is not in the agent's `SOUL.md`).
- Search local retailers and distributors first; report in the local currency.
- Give foreign prices only as labelled references with their currency.

### 4. Reporting
Present findings in a table with these columns:
| Seller | Exact Listing Title | Price (incl. tax/delivery?) | Stock Status | URL | Time Read | Tool Used |
|---|---|---|---|---|---|---|

Follow the table with:
- **Lowest verified price:** the best in-stock price from a verified seller.
- **Verification summary:** how many sources were actually opened and fully read.
- **Failed attempts:** pages that could not be loaded, and why.

## Pitfalls

- **Snippet reliance:** search previews are often outdated or show a range, not a fact.
- **Variant mismatch:** two items that share a name but differ in model number, generation or storage capacity are not the same product.
- **Currency/tax blindness:** never assume a price is "all-in" or in a given currency without seeing that on the page.
- **Unverified leads:** a product found in a "top 10" list is not reported until the retailer's own page confirms the price.

## See Also

- `source-driven-development` and `planning-and-task-breakdown` (in the `agent-skills` pack) for planning larger research jobs.
