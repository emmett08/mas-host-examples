/* Finite receipt admission abstraction. Identity values stand for exact
 * SHA-256/revision/UID equality, not collision resistance or test adequacy.
 * An independent verifier can report success for an earlier candidate or
 * requirement/test/environment/image version. Every identity is rechecked
 * at promotion; passing one version does not authorise another version.
 */
byte receipt_tree = 1;
byte current_tree;
byte receipt_requirements = 1;
byte current_requirements;
byte receipt_tests = 1;
byte current_tests;
byte receipt_environment = 1;
byte current_environment;
byte receipt_image = 1;
byte current_image;
bool authorised_verifier;
bool mandatory_pass;
bool receipt_authorised = false;
bool promoted = false;

#ifdef BUG_TREE
#define tree_guard true
#else
#define tree_guard (receipt_tree == current_tree)
#endif
#ifdef BUG_REQUIREMENTS
#define requirement_guard true
#else
#define requirement_guard (receipt_requirements == current_requirements)
#endif
#ifdef BUG_TESTS
#define test_guard true
#else
#define test_guard (receipt_tests == current_tests)
#endif
#ifdef BUG_ENVIRONMENT
#define environment_guard true
#else
#define environment_guard (receipt_environment == current_environment)
#endif
#ifdef BUG_IMAGE
#define image_guard true
#else
#define image_guard (receipt_image == current_image)
#endif
#ifdef BUG_VERIFIER
#define verifier_guard true
#else
#define verifier_guard authorised_verifier
#endif
#ifdef BUG_MANDATORY
#define mandatory_guard true
#else
#define mandatory_guard mandatory_pass
#endif

inline choose_identity(value) { if :: value = 1 :: value = 2 fi }
inline choose_bool(value) { if :: value = false :: value = true fi }

init {
    choose_identity(current_tree);
    choose_identity(current_requirements);
    choose_identity(current_tests);
    choose_identity(current_environment);
    choose_identity(current_image);
    choose_bool(authorised_verifier);
    choose_bool(mandatory_pass);
    if
    :: verifier_guard -> receipt_authorised = true
    :: else -> skip
    fi;
    if
    :: receipt_authorised && mandatory_guard && tree_guard && requirement_guard &&
       test_guard && environment_guard && image_guard ->
        promoted = true;
        assert(authorised_verifier); /* PROTECTED_VERIFIER_AUTHORITY */
        assert(mandatory_pass); /* EVERY_MANDATORY_CRITERION_PASSES */
        assert(receipt_tree == current_tree); /* EXACT_CANDIDATE */
        assert(receipt_requirements == current_requirements); /* EXACT_REQUIREMENTS */
        assert(receipt_tests == current_tests); /* EXACT_TEST_VERSION */
        assert(receipt_environment == current_environment); /* MATCHED_ENVIRONMENT */
        assert(receipt_image == current_image) /* IMMUTABLE_IMAGE */
    :: else -> skip
    fi;
#ifdef WITNESS_RECOVERY
    assert(!promoted) /* Reachability control: valid recovery must be reachable. */
#endif
}
