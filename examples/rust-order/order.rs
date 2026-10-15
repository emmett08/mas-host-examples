use mas_host_sdk::{json, Context, Json, Result};
use std::collections::BTreeSet;

pub fn quote(_context: &mut Context, input: Json) -> Result<Json> {
    calculate(&input)
}

/// All monetary amounts use one caller-selected currency's minor unit.
/// Discount rounds down; tax rounds to nearest minor unit, with halves up.
pub fn calculate(input: &Json) -> Result<Json> {
    let order = input["order_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or("order_id must contain 1..64 UTF-8 bytes")?;
    let items = input["items"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or("items must contain 1..32 lines")?;
    let discount_bps = unsigned(input, "discount_bps", 10_000)?;
    let tax_bps = unsigned(input, "tax_bps", 10_000)?;
    let shipping = unsigned(input, "shipping_minor", u64::MAX)?;
    let budget = unsigned(input, "budget_minor", u64::MAX)?;
    let mut seen = BTreeSet::new();
    let mut subtotal = 0_u64;
    let mut units = 0_u64;
    for item in items {
        let sku = item["sku"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 64)
            .ok_or("sku must contain 1..64 UTF-8 bytes")?;
        if !seen.insert(sku) {
            return Err("each sku must occur in one line".into());
        }
        let quantity = unsigned(item, "quantity", 1_000_000)?;
        if quantity == 0 {
            return Err("quantity must be positive".into());
        }
        let price = unsigned(item, "unit_minor", 1_000_000_000_000)?;
        let line = quantity.checked_mul(price).ok_or("line amount overflow")?;
        subtotal = subtotal.checked_add(line).ok_or("subtotal exceeds u64")?;
        units = units.checked_add(quantity).ok_or("unit count overflow")?;
    }
    // Widen only the intermediate product: all published amounts fit u64.
    let discount = ((subtotal as u128 * discount_bps as u128) / 10_000) as u64;
    let net = subtotal
        .checked_sub(discount)
        .ok_or("discount exceeds subtotal")?;
    let tax = u64::try_from((net as u128 * tax_bps as u128 + 5_000) / 10_000)
        .map_err(|_| "tax exceeds u64")?;
    let total = net
        .checked_add(tax)
        .and_then(|v| v.checked_add(shipping))
        .ok_or("total exceeds u64")?;
    Ok(
        json!({"order_id":order,"item_count":items.len(),"unit_count":units,
        "subtotal_minor":subtotal,"discount_minor":discount,"net_minor":net,
        "tax_minor":tax,"shipping_minor":shipping,"total_minor":total,
        "within_budget":total <= budget}),
    )
}

fn unsigned(input: &Json, field: &str, maximum: u64) -> Result<u64> {
    input[field]
        .as_u64()
        .filter(|v| *v <= maximum)
        .ok_or_else(|| format!("{field} must be an integer in 0..={maximum}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> Json {
        json!({"order_id":"order-001","items":[
        {"sku":"gear","quantity":3,"unit_minor":1250},
        {"sku":"seal","quantity":2,"unit_minor":475}],
        "discount_bps":500,"tax_bps":2000,"shipping_minor":300,"budget_minor":6000})
    }

    #[test]
    fn exact_quote_and_budget_boundary() {
        let mut input = proposal();
        let output = calculate(&input).unwrap();
        assert_eq!(output["subtotal_minor"], 4700);
        assert_eq!(output["discount_minor"], 235);
        assert_eq!(output["tax_minor"], 893);
        assert_eq!(output["total_minor"], 5658);
        input["budget_minor"] = json!(5658);
        assert_eq!(calculate(&input).unwrap()["within_budget"], true);
        input["budget_minor"] = json!(5657);
        assert_eq!(calculate(&input).unwrap()["within_budget"], false);
    }

    #[test]
    fn rounding_and_full_discount() {
        let mut input = proposal();
        input["items"] = json!([{"sku":"small","quantity":1,"unit_minor":5}]);
        input["discount_bps"] = json!(1000); // 0.5 minor unit rounds down.
        input["tax_bps"] = json!(1000); // 0.5 minor unit rounds up.
        let result = calculate(&input).unwrap();
        assert_eq!(result["discount_minor"], 0);
        assert_eq!(result["tax_minor"], 1);
        input["discount_bps"] = json!(10000);
        assert_eq!(calculate(&input).unwrap()["total_minor"], 300);
    }

    #[test]
    fn malformed_and_overflowing_orders_fail() {
        let mut input = proposal();
        input["items"][1]["sku"] = json!("gear");
        assert!(calculate(&input).unwrap_err().contains("one line"));
        input = proposal();
        input["items"][0]["quantity"] = json!(-1);
        assert!(calculate(&input).is_err());
        input = proposal();
        input["shipping_minor"] = json!(u64::MAX);
        assert_eq!(calculate(&input).unwrap_err(), "total exceeds u64");
        input["items"] = Json::Array(
            (0..19)
                .map(|i| {
                    json!({"sku":i.to_string(),
            "quantity":1_000_000,"unit_minor":1_000_000_000_000_u64})
                })
                .collect(),
        );
        assert_eq!(calculate(&input).unwrap_err(), "subtotal exceeds u64");
    }
}
