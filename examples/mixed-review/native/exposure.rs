use mas_host_sdk::{json, Context, Json, Result};

pub fn assess(_context: &mut Context, input: Json) -> Result<Json> {
    calculate(&input)
}

pub fn calculate(input: &Json) -> Result<Json> {
    let amount = |field: &str| {
        input[field]
            .as_u64()
            .filter(|v| *v <= 1_000_000_000_000)
            .ok_or_else(|| format!("{field} must be an integer in 0..1000000000000"))
    };
    let current = amount("current_commitment_minor")?;
    let purchase = amount("purchase_minor")?;
    if purchase == 0 {
        return Err("purchase_minor must be positive".into());
    }
    let limit = amount("credit_limit_minor")?;
    let projected = current
        .checked_add(purchase)
        .ok_or("projected commitment overflow")?;
    Ok(
        json!({"projected_minor":projected,"remaining_minor":limit.saturating_sub(projected),
        "within_limit":projected <= limit}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inclusive_limit_and_refusal() {
        let mut input = json!({"current_commitment_minor":120000,"purchase_minor":80000,"credit_limit_minor":200000});
        assert_eq!(
            calculate(&input).unwrap(),
            json!({"projected_minor":200000,"remaining_minor":0,"within_limit":true})
        );
        input["credit_limit_minor"] = json!(199999);
        assert_eq!(calculate(&input).unwrap()["within_limit"], false);
        input["purchase_minor"] = json!(0);
        assert!(calculate(&input).is_err());
    }
    #[test]
    fn reject_out_of_range_inputs() {
        let input = json!({"current_commitment_minor":1_000_000_000_001_u64,"purchase_minor":1,"credit_limit_minor":1});
        assert!(calculate(&input).is_err());
    }
}
