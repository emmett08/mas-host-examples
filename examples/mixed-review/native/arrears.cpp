#include "mas.hpp"
#include <algorithm>
#include <cstdint>
#include <string>

namespace arrears {
std::uint64_t unsigned_value(const mas::Json& value, const std::string& field, std::uint64_t maximum) {
    if (!value.is_number_integer() || (!value.is_number_unsigned() && value.get<std::int64_t>() < 0))
        throw std::runtime_error(field + " must be a non-negative integer");
    const auto number = value.get<std::uint64_t>();
    if (number > maximum) throw std::runtime_error(field + " exceeds its declared bound");
    return number;
}

mas::Json assess(const mas::Json& input) {
    const auto limit = unsigned_value(input.at("max_overdue_minor"), "max_overdue_minor", 1000000000000);
    const auto days_limit = unsigned_value(input.at("max_overdue_days"), "max_overdue_days", 36500);
    const auto& invoices = input.at("invoices");
    if (!invoices.is_array() || invoices.empty() || invoices.size() > 64)
        throw std::runtime_error("invoices must contain 1..64 records");
    std::uint64_t total = 0, oldest = 0;
    for (const auto& invoice : invoices) {
        const auto amount = unsigned_value(invoice.at("amount_minor"), "amount_minor", 1000000000000);
        const auto days = unsigned_value(invoice.at("days_overdue"), "days_overdue", 36500);
        if (amount > 0 && days > 0) {
            // At most 64 * 10^12, so uint64 addition cannot overflow.
            total += amount;
            oldest = std::max(oldest, days);
        }
    }
    return {{"overdue_minor",total},{"oldest_days",oldest},
        {"within_policy",total <= limit && oldest <= days_limit}};
}
} // namespace arrears

mas::Json Assess(mas::Context&, const mas::Json& input) {
    return arrears::assess(input);
}
