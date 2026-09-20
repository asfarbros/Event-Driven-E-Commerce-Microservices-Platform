package com.orderflow.inventory.seed;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.orderflow.inventory.config.InventoryProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * SEED — creates an inventory row for every product Catalog has, so the two
 * services line up for demos. Run explicitly (never on boot):
 *
 * <pre>
 *   scripts/seed.sh                 # insert missing rows only; existing rows untouched
 *   scripts/seed.sh --update        # also reset existing rows' available to the seed quantity
 * </pre>
 *
 * Product ids come from the Catalog HTTP API ({@code CATALOG_SERVICE_URL}
 * {@code /products?limit=100}) — never from catalog_db, which this service
 * must not open. Idempotent: rows are upserted by product_id with
 * {@code ON CONFLICT}, so any number of runs leaves one row per product.
 *
 * The seed quantity is deterministic per SKU (see {@link #seedQuantity}) so
 * demo numbers are stable across machines.
 */
@Component
@ConditionalOnProperty(name = "inventory.seed.enabled", havingValue = "true")
public class SeedRunner implements ApplicationRunner, ExitCodeGenerator {

    private static final Logger log = LoggerFactory.getLogger(SeedRunner.class);

    private final JdbcTemplate jdbc;
    private final InventoryProperties properties;
    private int exitCode;

    public SeedRunner(JdbcTemplate jdbc, InventoryProperties properties) {
        this.jdbc = jdbc;
        this.properties = properties;
    }

    @Override
    public void run(ApplicationArguments args) {
        boolean update = args.containsOption("update");
        try {
            seed(update);
        } catch (Exception e) {
            log.error("[seed] failed: {}", e.getMessage());
            exitCode = 1;
        }
        // InventoryApplication.main exits the JVM with getExitCode() in seed mode.
    }

    void seed(boolean update) {
        String catalogUrl = properties.seed().catalogUrl().replaceAll("/+$", "");
        log.info("[seed] fetching products from Catalog at {}", catalogUrl);

        RestClient client = RestClient.create();
        JsonNode page = client.get().uri(catalogUrl + "/products?limit=100").retrieve().body(JsonNode.class);
        if (page == null || !page.has("items")) {
            throw new IllegalStateException("unexpected Catalog response (no items array)");
        }

        List<Map<String, Object>> products = new ArrayList<>();
        for (JsonNode item : page.get("items")) {
            products.add(Map.of("id", item.get("id").asText(), "sku", item.get("sku").asText(), "name", item.get("name").asText()));
        }
        log.info("[seed] {} products in Catalog", products.size());

        int inserted = 0, updated = 0, untouched = 0;
        for (Map<String, Object> p : products) {
            String productId = (String) p.get("id");
            int quantity = seedQuantity((String) p.get("sku"));
            String sql = update
                    ? "insert into inventory (product_id, available, reserved) values (?, ?, 0) "
                      + "on conflict (product_id) do update set available = excluded.available "
                      + "returning (xmax = 0) as inserted"
                    : "insert into inventory (product_id, available, reserved) values (?, ?, 0) "
                      + "on conflict (product_id) do nothing returning true as inserted";
            List<Boolean> result = jdbc.query(sql, (rs, i) -> rs.getBoolean("inserted"), productId, quantity);
            if (result.isEmpty()) {
                untouched++;
            } else if (result.get(0)) {
                inserted++;
            } else {
                updated++;
            }
            log.info("[seed] {} {} → available={}", result.isEmpty() ? "kept    " : result.get(0) ? "inserted" : "updated ",
                    p.get("sku") + " (" + productId + ")", result.isEmpty() ? "(unchanged)" : quantity);
        }

        Integer total = jdbc.queryForObject("select count(*) from inventory", Integer.class);
        log.info("[seed] inserted: {}, updated: {}, already present (untouched): {}", inserted, updated, untouched);
        log.info("[seed] total inventory rows in {}: {}", properties.dbName(), total);
    }

    /**
     * Deterministic demo quantities: 5-60 units derived from the SKU so a given
     * product always seeds the same figure (e.g. the headphones are always
     * short-ish, the football always plentiful).
     */
    static int seedQuantity(String sku) {
        int hash = 0;
        for (char c : sku.toCharArray()) {
            hash = hash * 31 + c;
        }
        return 5 + Math.floorMod(hash, 56);
    }

    @Override
    public int getExitCode() {
        return exitCode;
    }
}
