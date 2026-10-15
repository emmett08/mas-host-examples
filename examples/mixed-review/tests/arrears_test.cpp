#include "../native/arrears.cpp"
#include <cassert>

int main() {
    mas::Json input = {{"max_overdue_minor",5000},{"max_overdue_days",7},
        {"invoices",{{{"amount_minor",10000},{"days_overdue",0}},{{"amount_minor",5000},{"days_overdue",7}}}}};
    auto result = arrears::assess(input);
    assert(result.at("overdue_minor") == 5000 && result.at("oldest_days") == 7);
    assert(result.at("within_policy") == true);
    input["max_overdue_days"] = 6;
    assert(arrears::assess(input).at("within_policy") == false);
    input["invoices"] = {{{"amount_minor",0},{"days_overdue",36500}}};
    result = arrears::assess(input);
    assert(result.at("overdue_minor") == 0 && result.at("oldest_days") == 0);
    for (const mas::Json& bad : {mas::Json(-1), mas::Json(false), mas::Json(1000000000001LL)}) {
        input["invoices"][0]["amount_minor"] = bad;
        bool failed = false;
        try { arrears::assess(input); } catch (const std::exception&) { failed = true; }
        assert(failed);
    }
}
