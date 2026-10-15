#include "../telemetry.cpp"
#include <cassert>

int main() {
    mas::Json input = {{"sensor","pump-7"},{"samples",{410,420,425,470,480,415}},
        {"min_allowed",400},{"max_allowed",450},{"max_breaches",1}};
    auto result = telemetry::analyse(input);
    assert(result.at("sum") == 2620 && result.at("mean_floor") == 436);
    assert(result.at("breaches") == 2 && result.at("first_breach_index") == 3);
    assert(result.at("acceptable") == false);
    input["max_breaches"] = 2;
    assert(telemetry::analyse(input).at("acceptable") == true);
    input["samples"] = {-2,-1};
    input["min_allowed"] = -2;
    input["max_allowed"] = -1;
    result = telemetry::analyse(input);
    assert(result.at("mean_floor") == -2 && result.at("first_breach_index") == -1);
    for (const mas::Json& bad : {mas::Json::array(), mas::Json::array({1000001}),
            mas::Json::array({std::numeric_limits<std::uint64_t>::max()}), mas::Json::array({false})}) {
        input["samples"] = bad;
        bool failed = false;
        try { telemetry::analyse(input); } catch (const std::exception&) { failed = true; }
        assert(failed);
    }
    input["samples"] = mas::Json::array();
    for (int i = 0; i < 1024; ++i) input["samples"].push_back(-1000000);
    input["min_allowed"] = -1000000;
    input["max_allowed"] = 1000000;
    assert(telemetry::analyse(input).at("sum") == -1024000000);
}
