#include "mas.hpp"
#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>

namespace telemetry {

std::int64_t bounded(const mas::Json& value, const std::string& name) {
    if (!value.is_number_integer()) throw std::runtime_error(name + " must be an integer");
    if (value.is_number_unsigned() && value.get<std::uint64_t>() > 1000000)
        throw std::runtime_error(name + " must lie in -1000000..1000000");
    const auto number = value.get<std::int64_t>();
    if (number < -1000000 || number > 1000000)
        throw std::runtime_error(name + " must lie in -1000000..1000000");
    return number;
}

mas::Json analyse(const mas::Json& input) {
    const auto& sensor = input.at("sensor");
    if (!sensor.is_string() || sensor.get_ref<const std::string&>().empty() ||
        sensor.get_ref<const std::string&>().size() > 64)
        throw std::runtime_error("sensor must contain 1..64 UTF-8 bytes");
    const auto& values = input.at("samples");
    if (!values.is_array() || values.empty() || values.size() > 1024)
        throw std::runtime_error("samples must contain 1..1024 integers");
    const auto low = bounded(input.at("min_allowed"), "min_allowed");
    const auto high = bounded(input.at("max_allowed"), "max_allowed");
    const auto allowed = bounded(input.at("max_breaches"), "max_breaches");
    if (low > high || allowed < 0 || allowed > 1024)
        throw std::runtime_error("require min_allowed <= max_allowed and max_breaches in 0..1024");
    std::int64_t sum = 0, minimum = 1000000, maximum = -1000000;
    std::int64_t breaches = 0, first = -1;
    for (std::size_t index = 0; index < values.size(); ++index) {
        const auto value = bounded(values[index], "sample");
        // Bounds above prove |sum| <= 1024 * 1000000, comfortably inside int64.
        sum += value;
        minimum = std::min(minimum, value);
        maximum = std::max(maximum, value);
        if (value < low || value > high) {
            ++breaches;
            if (first == -1) first = static_cast<std::int64_t>(index);
        }
    }
    const auto count = static_cast<std::int64_t>(values.size());
    auto mean = sum / count;
    if (sum < 0 && sum % count != 0) --mean; // Mathematical floor, including negatives.
    return {{"sensor",sensor},{"samples",count},{"min",minimum},{"max",maximum},
        {"sum",sum},{"mean_floor",mean},{"breaches",breaches},
        {"first_breach_index",first},{"acceptable",breaches <= allowed}};
}
} // namespace telemetry

mas::Json Analyse(mas::Context&, const mas::Json& input) {
    return telemetry::analyse(input);
}
